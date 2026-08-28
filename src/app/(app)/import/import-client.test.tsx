// Sol round-2 audit (2026-08-27) — pins four findings against the shared
// PreviewStep/RowFixItem UI:
//   finding 1 — a row belonging to an already-CONFIRMED chunk renders its
//     inline-fix inputs read-only, with explanatory copy, instead of
//     silently accepting edits that could never actually be resent.
//   finding 3 — chunk_content_mismatch is terminal: no "Retry upload"
//     button, and the server's own (already-explanatory) message renders.
//   finding 4 — the error-row cap is incremental disclosure, not a hard
//     cutoff: "Show N more" reveals the next page, repeatable.
//   finding 5 — a chunked error row's label is "Chunk N, data row M" (an
//     honest, chunk-scoped claim), never "Row {pseudo-global number}".
import { act, useState, type ComponentProps, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ImportClient,
  PreviewStep,
  BatchStep,
  isRowInConfirmedChunk,
  isRowInSkippedChunk,
  buildImportAnywayOverride,
  skipChunk,
  undoSkipChunk,
  visibleConflictCandidates,
  MAX_SHOWN_ERROR_ROWS,
  type ErrorRowEntry,
  type BatchDetail,
} from "./import-client";
import { CONFLICT_UNDISPLAYED_NOTE, type ConflictingBatchInfo } from "./conflicting-batches";
import { ZERO_SUMMARY, confirmChunkedSession, type ChunkUploadState, type ChunkedPlanState } from "./session-step";
import { CANONICAL_HEADERS, type CanonicalHeader } from "@/domains/import/constants";

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousActEnvironment = reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT;

beforeAll(() => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

const EMPTY_RAW_TEXT: Record<CanonicalHeader, string> = {
  producer: "",
  name: "",
  vintage: "",
  varietal: "",
  region: "",
  country: "",
  size_ml: "",
  format: "",
  currency: "",
  quantity: "",
  unit_cost: "",
  bin: "",
  section: "",
};

function errorRow(rowNumber: number, extra: Partial<ErrorRowEntry> = {}): ErrorRowEntry {
  return {
    rowNumber,
    errors: [{ field: "quantity", message: "Quantity is required." }],
    rawText: { ...EMPTY_RAW_TEXT, producer: "Domaine", name: `Wine ${rowNumber}` },
    ...extra,
  };
}

type PreviewStepProps = ComponentProps<typeof PreviewStep>;

function baseProps(overrides: Partial<PreviewStepProps> = {}): PreviewStepProps {
  return {
    filename: "cellar.csv",
    summary: { ...ZERO_SUMMARY },
    errorRows: [],
    rowOverrides: {},
    onRowFieldChange: () => {},
    isRowLocked: () => false,
    isRowSkipped: () => false,
    chunkUpload: null,
    onConfirm: () => {},
    confirming: false,
    onBack: () => {},
    error: null,
    ...overrides,
  };
}

describe("isRowInConfirmedChunk (Sol round-2 audit finding 1)", () => {
  const PLAN: ChunkedPlanState = {
    headerRecord: "producer,name,quantity",
    chunkTotal: 2,
    chunks: [
      { index: 1, startRow: 1, endRow: 2, text: "" },
      { index: 2, startRow: 3, endRow: 4, text: "" },
    ],
    sourceSha256: "a".repeat(64),
  };
  const UPLOAD: ChunkUploadState[] = [
    { index: 1, status: "confirmed", batchId: "b1", error: null, code: null },
    { index: 2, status: "pending", batchId: null, error: null, code: null },
  ];

  it("is false on the plain (non-chunked) path", () => {
    expect(isRowInConfirmedChunk(1, null, null)).toBe(false);
  });

  it("is true for a row inside a CONFIRMED chunk's [startRow, endRow] range", () => {
    expect(isRowInConfirmedChunk(1, PLAN, UPLOAD)).toBe(true);
    expect(isRowInConfirmedChunk(2, PLAN, UPLOAD)).toBe(true);
  });

  it("is false for a row inside an UNCONFIRMED chunk's range", () => {
    expect(isRowInConfirmedChunk(3, PLAN, UPLOAD)).toBe(false);
    expect(isRowInConfirmedChunk(4, PLAN, UPLOAD)).toBe(false);
  });

  it("is false for a row number outside every chunk's range", () => {
    expect(isRowInConfirmedChunk(99, PLAN, UPLOAD)).toBe(false);
  });
});

// Round-6 audit finding 5: the skipped-chunk counterpart of
// isRowInConfirmedChunk — a skipped chunk's rows were never sent to the
// server either, so they're just as locked, for a distinct reason.
describe("isRowInSkippedChunk (round-6 audit finding 5)", () => {
  const PLAN: ChunkedPlanState = {
    headerRecord: "producer,name,quantity",
    chunkTotal: 2,
    chunks: [
      { index: 1, startRow: 1, endRow: 2, text: "" },
      { index: 2, startRow: 3, endRow: 4, text: "" },
    ],
    sourceSha256: "a".repeat(64),
  };
  const UPLOAD: ChunkUploadState[] = [
    { index: 1, status: "skipped", batchId: null, error: null, code: null },
    { index: 2, status: "confirmed", batchId: "b2", error: null, code: null },
  ];

  it("is false on the plain (non-chunked) path", () => {
    expect(isRowInSkippedChunk(1, null, null)).toBe(false);
  });

  it("is true for a row inside a SKIPPED chunk's [startRow, endRow] range", () => {
    expect(isRowInSkippedChunk(1, PLAN, UPLOAD)).toBe(true);
    expect(isRowInSkippedChunk(2, PLAN, UPLOAD)).toBe(true);
  });

  it("is false for a row inside a CONFIRMED chunk's range", () => {
    expect(isRowInSkippedChunk(3, PLAN, UPLOAD)).toBe(false);
    expect(isRowInSkippedChunk(4, PLAN, UPLOAD)).toBe(false);
  });

  it("is false for a row number outside every chunk's range", () => {
    expect(isRowInSkippedChunk(99, PLAN, UPLOAD)).toBe(false);
  });
});

// Round-23 audit (SIMPLIFY): three straight audits (rounds 18, 20, 22)
// found a different way this codebase's LOCAL "is this multiple_live_batches
// conflict resolved" inference got the answer wrong. isConflictSourceResolved,
// unresolvedConflictCandidates, and applyRevertToChunkUpload are gone —
// nothing client-side decides "resolved" anymore; the server does, by
// re-checking on every confirm attempt. All that's left to pin directly is
// the trivial, honest bit: visibleConflictCandidates drops a candidate ONLY
// once THIS client has actually confirmed reverting it — never by any
// count/threshold guess. WARN 3 (round-22 audit) is fixed by construction
// here: a source's lone remaining candidate is never suppressed.
describe("visibleConflictCandidates (round-23 audit — SIMPLIFY)", () => {
  const TWO: ConflictingBatchInfo[] = [
    { id: "a", filename: "cellar.csv", status: "created", created_at: "2020-01-01T00:00:00Z" },
    { id: "b", filename: "cellar.csv", status: "applying", created_at: "2021-01-01T00:00:00Z" },
  ];

  it("offers every candidate when nothing has been reverted yet", () => {
    expect(visibleConflictCandidates(TWO, new Set())).toEqual(TWO);
  });

  it("drops only a candidate whose id is in revertedIds, keeping every other one — including a lone survivor", () => {
    expect(visibleConflictCandidates(TWO, new Set(["a"]))).toEqual([TWO[1]]);
    // WARN 3 (round-22 audit): a source down to ONE remaining candidate
    // must still offer it — the old isConflictSourceResolved fallback
    // could suppress exactly this candidate when no count was carried.
    // Nothing here treats "one left" as special at all.
    expect(visibleConflictCandidates([TWO[1]], new Set())).toEqual([TWO[1]]);
  });

  it("drops every candidate once every id has been reverted", () => {
    expect(visibleConflictCandidates(TWO, new Set(["a", "b"]))).toEqual([]);
  });

  it("returns an empty list for an undefined source (never had a conflict)", () => {
    expect(visibleConflictCandidates(undefined, new Set())).toEqual([]);
    expect(visibleConflictCandidates(undefined, new Set(["a"]))).toEqual([]);
  });
});

// Round-6 audit finding 3, made distinct-per-chunk by round-7 audit finding
// 2: the deterministic, pure logic behind "Import anyway" — building a
// canonical no-op override from this chunk's known rows, DISTINCT per
// chunkIndex so two identical sibling chunks never regenerate the same
// digest.
describe("buildImportAnywayOverride (round-6 audit finding 3, round-7 audit finding 2)", () => {
  const RAW_TEXT: Record<CanonicalHeader, string> = {
    ...EMPTY_RAW_TEXT,
    producer: "Domaine Example",
    name: "Cuvee One",
    vintage: "2020",
  };
  const FIRST_ROW = { rowNumber: 5, rawText: RAW_TEXT };

  it("builds an override using the first data row's existing values, for chunkIndex 1", () => {
    const built = buildImportAnywayOverride(1, FIRST_ROW, []);
    expect(built).toEqual({ ok: true, overridePatch: { 5: { producer: "Domaine Example" } } });
  });

  it("is deterministic — the same chunk + preview always produces the identical override", () => {
    const a = buildImportAnywayOverride(2, FIRST_ROW, []);
    const b = buildImportAnywayOverride(2, FIRST_ROW, []);
    expect(a).toEqual(b);
  });

  it("returns null when there is no first-row data to build from", () => {
    expect(buildImportAnywayOverride(1, null, [])).toBeNull();
  });

  // Round-7 audit finding 2: two identical siblings (same underlying
  // rows, hence the same grid) must land on DIFFERENT chunkIndex values —
  // and therefore distinct override sizes, hence distinct canonicalized
  // digests, hence both reach create instead of the second one dead-ending
  // on the same collision.
  it("produces a DIFFERENT override for a different chunkIndex against the identical underlying rows", () => {
    const a = buildImportAnywayOverride(1, FIRST_ROW, []);
    const b = buildImportAnywayOverride(2, FIRST_ROW, []);
    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: true });
    expect(a).not.toEqual(b);
  });

  it("grows the grid using this chunk's own error rows once the first row's non-blank fields are exhausted", () => {
    // FIRST_ROW has 3 non-blank fields (producer, name, vintage) — gridSize
    // 3 from the first row alone. chunkIndex 4 needs a 4th cell, pulled
    // from an error row belonging to the same chunk.
    const errorRow = { rowNumber: 6, rawText: { ...EMPTY_RAW_TEXT, region: "Burgundy" } };
    const built = buildImportAnywayOverride(4, FIRST_ROW, [errorRow]);
    expect(built).toMatchObject({ ok: true });
    if (built?.ok) {
      expect(built.overridePatch[6]).toEqual({ region: "Burgundy" });
    }
  });

  // Round-7 audit finding 2: the exhaustion path — more identical siblings
  // than this chunk has distinct non-blank cells to offer.
  it("reports exhaustion, never a doomed-to-collide override, once chunkIndex exceeds this chunk's grid size", () => {
    const outcome = buildImportAnywayOverride(4, FIRST_ROW, []); // grid size 3, chunkIndex 4
    expect(outcome).toEqual({ ok: false, reason: "exhausted", gridSize: 3 });
  });
});

describe("PreviewStep — locked rows in a confirmed chunk (Sol round-2 audit finding 1)", () => {
  const mountedRoots: Root[] = [];

  afterEach(async () => {
    for (const root of mountedRoots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
  });

  it("renders a locked row's inputs disabled with explanatory copy, and leaves an unlocked row editable", async () => {
    const { container } = await mount(
      <PreviewStep
        {...baseProps({
          errorRows: [errorRow(1), errorRow(3)],
          isRowLocked: (rowNumber) => rowNumber === 1,
        })}
      />,
    );

    const lockedItem = rowItem(container, "Row 1");
    const unlockedItem = rowItem(container, "Row 3");

    const lockedInput = lockedItem.querySelector("input")!;
    expect(lockedInput.disabled).toBe(true);
    expect(lockedItem.textContent).toContain("Row already imported with this chunk — revert the import to change it.");

    const unlockedInput = unlockedItem.querySelector("input")!;
    expect(unlockedInput.disabled).toBe(false);
    expect(unlockedItem.textContent).not.toContain("Row already imported with this chunk");
  });

  // Round-6 audit finding 5: a skipped chunk's rows are just as locked as
  // a confirmed chunk's, but for a DISTINCT reason, so they render a
  // distinct message.
  it("renders a skipped-chunk row's inputs disabled with the distinct 'skipped chunk' message", async () => {
    const { container } = await mount(
      <PreviewStep
        {...baseProps({
          errorRows: [errorRow(1), errorRow(3)],
          isRowSkipped: (rowNumber) => rowNumber === 1,
        })}
      />,
    );

    const skippedItem = rowItem(container, "Row 1");
    const otherItem = rowItem(container, "Row 3");

    const skippedInput = skippedItem.querySelector("input")!;
    expect(skippedInput.disabled).toBe(true);
    expect(skippedItem.textContent).toContain("Row belongs to a skipped chunk.");
    expect(skippedItem.textContent).not.toContain("Row already imported with this chunk");

    const otherInput = otherItem.querySelector("input")!;
    expect(otherInput.disabled).toBe(false);
    expect(otherItem.textContent).not.toContain("skipped chunk");
  });

  async function mount(element: ReactElement) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => root.render(element));
    return { container, root };
  }
});

describe("PreviewStep — confirm-in-flight freeze (Sol round-3 audit finding 1)", () => {
  const mountedRoots: Root[] = [];

  afterEach(async () => {
    for (const root of mountedRoots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
  });

  it("freezes every row-fix input while a confirm attempt is in flight, then unlocks failed/unattempted rows once it settles", async () => {
    const { container, root } = await mount(
      <PreviewStep {...baseProps({ errorRows: [errorRow(1), errorRow(2)], confirming: true })} />,
    );

    expect(rowItem(container, "Row 1").querySelector("input")!.disabled).toBe(true);
    expect(rowItem(container, "Row 2").querySelector("input")!.disabled).toBe(true);
    expect(container.textContent).toContain("Import in progress — row edits are locked during upload.");

    // The attempt settles: confirming flips back to false. Neither row
    // belongs to a chunk that actually got confirmed (a failed or
    // never-attempted chunk), so isRowLocked stays false for both —
    // editing must be possible again immediately, not just eventually.
    await act(async () =>
      root.render(
        <PreviewStep {...baseProps({ errorRows: [errorRow(1), errorRow(2)], confirming: false, isRowLocked: () => false })} />,
      ),
    );

    expect(rowItem(container, "Row 1").querySelector("input")!.disabled).toBe(false);
    expect(rowItem(container, "Row 2").querySelector("input")!.disabled).toBe(false);
    expect(container.textContent).not.toContain("Import in progress — row edits are locked during upload.");
  });

  it("keeps a row PERMANENTLY locked once its own chunk is confirmed, even after the freeze lifts", async () => {
    const { container, root } = await mount(
      <PreviewStep {...baseProps({ errorRows: [errorRow(1)], confirming: true, isRowLocked: () => true })} />,
    );
    expect(rowItem(container, "Row 1").querySelector("input")!.disabled).toBe(true);

    await act(async () =>
      root.render(
        <PreviewStep {...baseProps({ errorRows: [errorRow(1)], confirming: false, isRowLocked: () => true })} />,
      ),
    );
    const afterInput = rowItem(container, "Row 1").querySelector("input")!;
    expect(afterInput.disabled).toBe(true);
    expect(rowItem(container, "Row 1").textContent).toContain("Row already imported with this chunk");
  });

  async function mount(element: ReactElement) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => root.render(element));
    return { container, root };
  }
});

describe("PreviewStep — revalidated summary counts (Sol round-3 audit finding 5)", () => {
  const mountedRoots: Root[] = [];

  afterEach(async () => {
    for (const root of mountedRoots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
  });

  // Round-4 audit finding 3: "Ready to apply" overstated what a
  // client-side-passing row is actually guaranteed — the server can still
  // land it in the pending bucket or merge it as a duplicate at confirm
  // time. Relabeled to "Passing validation", with a permanent caption
  // saying so.
  it("moves a fixed row from Errors (excluded) into Passing validation, and notes the projection", async () => {
    const { container } = await mount(
      <PreviewStep
        {...baseProps({
          summary: { ...ZERO_SUMMARY, totalRows: 1, errorRows: 1, readyToApplyRows: 0 },
          errorRows: [errorRow(1, { rawText: { ...EMPTY_RAW_TEXT, producer: "Domaine", name: "Wine 1", quantity: "0.9" } })],
          rowOverrides: { 1: { quantity: "6" } },
        })}
      />,
    );

    const stats = new Map(
      [...container.querySelectorAll("dt")].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]),
    );
    expect(stats.get("Passing validation")).toBe("1");
    expect(stats.get("Errors (excluded)")).toBe("0");
    expect(container.textContent).toContain("Includes 1 row fixed above — re-checked when you confirm.");
    expect(container.textContent).toContain("The server decides the final ready/needs-resolution split at import");
  });

  it("leaves the counts untouched when nothing has been fixed yet", async () => {
    const { container } = await mount(
      <PreviewStep
        {...baseProps({
          summary: { ...ZERO_SUMMARY, totalRows: 1, errorRows: 1, readyToApplyRows: 0 },
          errorRows: [errorRow(1)],
        })}
      />,
    );

    const stats = new Map(
      [...container.querySelectorAll("dt")].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]),
    );
    expect(stats.get("Passing validation")).toBe("0");
    expect(stats.get("Errors (excluded)")).toBe("1");
    expect(container.textContent).not.toContain("re-checked when you confirm");
  });

  // Round-5 audit finding 5: "Passing validation" was computed from
  // summary.readyToApplyRows (rows with resolution === 'auto' — schema-valid
  // AND already auto-resolvable), not summary.validRows (every schema-valid
  // row) — so a perfectly valid-but-unmatched wine (needs LWIN/cost
  // resolution) rendered "Passing validation: 0" even though it passed
  // validation outright, alongside a correct-but-confusing "Needs
  // resolution: 1" on its own separate line.
  it("counts a valid-but-unmatched row toward Passing validation, not just readyToApplyRows", async () => {
    const { container } = await mount(
      <PreviewStep
        {...baseProps({
          summary: {
            ...ZERO_SUMMARY,
            totalRows: 1,
            validRows: 1,
            errorRows: 0,
            readyToApplyRows: 0, // needs resolution, so NOT auto-ready
            pendingResolutionRows: 1,
            unmatchedRows: 1,
          },
          errorRows: [],
        })}
      />,
    );

    const stats = new Map(
      [...container.querySelectorAll("dt")].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]),
    );
    expect(stats.get("Passing validation")).toBe("1");
    expect(stats.get("Needs resolution")).toBe("1");
  });

  // Round-6 audit finding 5: a row belonging to a SKIPPED chunk is
  // excluded from Passing validation / the "row(s) fixed" caption even
  // when its override would otherwise validate — that chunk's rows were
  // never sent, and never will be, so counting it would inflate what's
  // actually going to import.
  it("excludes a fixed row belonging to a SKIPPED chunk from Passing validation and the 'row(s) fixed' caption", async () => {
    const { container } = await mount(
      <PreviewStep
        {...baseProps({
          summary: { ...ZERO_SUMMARY, totalRows: 1, errorRows: 1, readyToApplyRows: 0 },
          errorRows: [errorRow(1, { rawText: { ...EMPTY_RAW_TEXT, producer: "Domaine", name: "Wine 1", quantity: "0.9" } })],
          rowOverrides: { 1: { quantity: "6" } },
          isRowSkipped: (rowNumber) => rowNumber === 1,
        })}
      />,
    );

    const stats = new Map(
      [...container.querySelectorAll("dt")].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]),
    );
    expect(stats.get("Passing validation")).toBe("0");
    expect(stats.get("Errors (excluded)")).toBe("1");
    expect(container.textContent).not.toContain("row(s) fixed above");
  });

  // Round-7 audit finding 5: the round-6 fix above only ever subtracted a
  // FIXED row belonging to a skipped chunk. A chunk's rows that were
  // already VALID before any fix — the common case for a fully-valid
  // duplicate_chunk_content chunk, which is exactly the kind of chunk an
  // operator skips — kept counting toward the aggregate "Passing
  // validation" even after the whole chunk was skipped, since
  // summary.validRows is a whole-file aggregate computed once at preview
  // time with no way to know about a LATER client-side skip.
  it("excludes a fully-valid SKIPPED chunk's originally-valid rows from Passing validation", async () => {
    const chunkBreakdown = [
      { index: 1, startRow: 1, endRow: 3, summary: { ...ZERO_SUMMARY, totalRows: 3, validRows: 3 } },
      { index: 2, startRow: 4, endRow: 5, summary: { ...ZERO_SUMMARY, totalRows: 2, validRows: 2 } },
    ];
    const chunkUpload: ChunkUploadState[] = [
      { index: 1, status: "confirmed", batchId: "b1", error: null, code: null },
      { index: 2, status: "skipped", batchId: null, error: null, code: null, duplicateOfChunkIndex: 1 },
    ];

    const { container } = await mount(
      <PreviewStep
        {...baseProps({
          summary: { ...ZERO_SUMMARY, totalRows: 5, validRows: 5 },
          errorRows: [],
          chunkBreakdown,
          chunkTotal: 2,
          chunkUpload,
        })}
      />,
    );

    const stats = new Map(
      [...container.querySelectorAll("dt")].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]),
    );
    // 5 aggregate valid rows minus chunk 2's own 2 (now skipped) = 3.
    expect(stats.get("Passing validation")).toBe("3");
  });

  // Round-7 audit finding 5: Undo skip needs no separate handling — the
  // count is a live re-derivation from the CURRENT chunkUpload on every
  // render, so a chunk leaving "skipped" simply restores its own valid
  // rows to the aggregate on the next render.
  it("restores the count once Undo skip takes the chunk out of 'skipped'", async () => {
    const chunkBreakdown = [
      { index: 1, startRow: 1, endRow: 3, summary: { ...ZERO_SUMMARY, totalRows: 3, validRows: 3 } },
      { index: 2, startRow: 4, endRow: 5, summary: { ...ZERO_SUMMARY, totalRows: 2, validRows: 2 } },
    ];
    const baseSummaryProps = {
      summary: { ...ZERO_SUMMARY, totalRows: 5, validRows: 5 },
      errorRows: [],
      chunkBreakdown,
      chunkTotal: 2,
    };

    const skipped = await mount(
      <PreviewStep
        {...baseProps({
          ...baseSummaryProps,
          chunkUpload: [
            { index: 1, status: "confirmed", batchId: "b1", error: null, code: null },
            { index: 2, status: "skipped", batchId: null, error: null, code: null, duplicateOfChunkIndex: 1 },
          ],
        })}
      />,
    );
    const skippedStats = new Map(
      [...skipped.container.querySelectorAll("dt")].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]),
    );
    expect(skippedStats.get("Passing validation")).toBe("3");

    const undone = await mount(
      <PreviewStep
        {...baseProps({
          ...baseSummaryProps,
          chunkUpload: [
            { index: 1, status: "confirmed", batchId: "b1", error: null, code: null },
            { index: 2, status: "failed", batchId: null, error: "conflict", code: "duplicate_chunk_content", duplicateOfChunkIndex: 1 },
          ],
        })}
      />,
    );
    const undoneStats = new Map(
      [...undone.container.querySelectorAll("dt")].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]),
    );
    expect(undoneStats.get("Passing validation")).toBe("5");
  });

  async function mount(element: ReactElement) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => root.render(element));
    return { container, root };
  }
});

describe("PreviewStep — honest chunk/data-row label (Sol round-2 audit finding 5)", () => {
  const mountedRoots: Root[] = [];

  afterEach(async () => {
    for (const root of mountedRoots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
  });

  it("labels a chunked row 'Chunk N, data row M', and a plain row 'Row N'", async () => {
    const { container } = await mount(
      <PreviewStep
        {...baseProps({
          errorRows: [
            errorRow(105, { chunkIndex: 2, chunkRowNumber: 1 }),
            errorRow(7),
          ],
        })}
      />,
    );

    expect(container.textContent).toContain("Chunk 2, data row 1");
    expect(container.textContent).not.toContain("Row 105");
    expect(rowItem(container, "Row 7")).toBeTruthy();
  });

  async function mount(element: ReactElement) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => root.render(element));
    return { container, root };
  }
});

describe("PreviewStep — chunk_content_mismatch is terminal (Sol round-2 audit finding 3)", () => {
  const mountedRoots: Root[] = [];

  afterEach(async () => {
    for (const root of mountedRoots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
  });

  it("hides the Retry button and renders the server's own message for chunk_content_mismatch", async () => {
    const serverMessage =
      "Chunk 1 of this import session was already confirmed with different content or row fixes. " +
      "Revert that import before re-uploading a corrected version of this chunk.";
    const chunkUpload: ChunkUploadState[] = [
      { index: 1, status: "failed", batchId: null, error: serverMessage, code: "chunk_content_mismatch" },
    ];

    const { container } = await mount(
      <PreviewStep {...baseProps({ chunkUpload, chunkTotal: 1, error: serverMessage })} />,
    );

    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.some((b) => b.textContent?.includes("Retry upload"))).toBe(false);
    expect(buttons.some((b) => b.textContent?.includes("Confirm import"))).toBe(false);
    expect(container.textContent).toContain(serverMessage);
  });

  it("still offers Retry for every OTHER (genuinely retryable) chunk failure", async () => {
    const chunkUpload: ChunkUploadState[] = [
      { index: 1, status: "failed", batchId: null, error: "Network error.", code: null },
    ];

    const { container } = await mount(
      <PreviewStep {...baseProps({ chunkUpload, chunkTotal: 1, error: "Chunk 1 of 1 failed to upload — you can retry it below." })} />,
    );

    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.some((b) => b.textContent?.includes("Retry upload"))).toBe(true);
  });

  async function mount(element: ReactElement) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => root.render(element));
    return { container, root };
  }
});

// Round-10 audit BLOCK 3(a): multiple_live_batches (reconciliation's own
// non-destructive conflict) and duplicate_race_retry_exhausted (WARN 5's
// bounded escalation) are the same kind of dead end as chunk_content_
// mismatch — retrying resends the exact same request and fails the exact
// same way every time. Neither used to be in the blocked-retry set, so
// PreviewStep still rendered "Retry upload" as if it might work.
describe("PreviewStep — multiple_live_batches and duplicate_race_retry_exhausted are terminal (round-10 audit BLOCK 3)", () => {
  const mountedRoots: Root[] = [];

  afterEach(async () => {
    for (const root of mountedRoots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
  });

  it("hides Retry upload and renders the server's own message for multiple_live_batches", async () => {
    const serverMessage =
      "This file has 2 live import batches for the same underlying content — this can't be resolved " +
      "automatically. Revert all but one of them from Recent imports before resuming or re-uploading this file.";
    const chunkUpload: ChunkUploadState[] = [
      { index: 1, status: "failed", batchId: null, error: serverMessage, code: "multiple_live_batches" },
    ];

    const { container } = await mount(
      <PreviewStep {...baseProps({ chunkUpload, chunkTotal: 1, error: serverMessage })} />,
    );

    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.some((b) => b.textContent?.includes("Retry upload"))).toBe(false);
    expect(buttons.some((b) => b.textContent?.includes("Confirm import"))).toBe(false);
    expect(container.textContent).toContain(serverMessage);
  });

  it("hides Retry upload and renders the escalation message for duplicate_race_retry_exhausted", async () => {
    const escalationMessage =
      "Chunk 1 of 1 still conflicts with another live import for this file after 3 attempts — this needs a " +
      "human to resolve. Revert the conflicting batch under Recent imports before uploading this file again.";
    const chunkUpload: ChunkUploadState[] = [
      { index: 1, status: "failed", batchId: null, error: escalationMessage, code: "duplicate_race_retry_exhausted", duplicateRaceRetryCount: 3 },
    ];

    const { container } = await mount(
      <PreviewStep {...baseProps({ chunkUpload, chunkTotal: 1, error: escalationMessage })} />,
    );

    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.some((b) => b.textContent?.includes("Retry upload"))).toBe(false);
    expect(container.textContent).toContain(escalationMessage);
  });

  async function mount(element: ReactElement) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => root.render(element));
    return { container, root };
  }
});

// Round-23 audit (SIMPLIFY, replaces the round-21 correction here): a chunk
// conflict PARSED down to one candidate (a malformed sibling entry dropped
// by parseConflictingBatches) is not treated as resolved OR unresolved —
// this client no longer decides either way. It stays terminal (no revert
// has happened yet, so hasRevertedAnyConflict is false), the one parseable
// candidate is shown with a revert affordance, and — round-22 audit BLOCK
// 2's own finding — the honest note fires from the count vs. the parsed
// array (or the server's own conflictingBatchesTruncated flag) rather than
// naming a specific missing count. Drives the REAL confirmChunkedSession
// mechanism, not a hand-built ChunkUploadState.
describe("PreviewStep — a chunk conflict that PARSES to one candidate stays blocked, with an honest note (round-23 audit — SIMPLIFY)", () => {
  const mountedRoots: Root[] = [];

  afterEach(async () => {
    for (const root of mountedRoots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("keeps Retry upload AND Confirm import hidden, shows the one parseable candidate, and states plainly that not everything could be displayed", async () => {
    const PLAN: ChunkedPlanState = {
      headerRecord: "producer,name,quantity",
      chunkTotal: 1,
      chunks: [{ index: 1, startRow: 1, endRow: 2, text: "producer,name,quantity\nA,B,1\n" }],
      sourceSha256: "c".repeat(64),
    };
    // The SERVER emitted two real candidates (conflictingBatchesCount: 2);
    // one entry is malformed (no created_at) — the exact response-shape-drift
    // case isConflictingBatchInfo's own comment describes.
    const wireConflictingBatches = [
      { id: "batch-a", filename: "cellar.csv", status: "created", created_at: "2026-01-01T00:00:00Z" },
      { id: "batch-b", filename: "cellar.csv", status: "applying" }, // malformed: no created_at
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/import/sessions")) {
          return new Response(JSON.stringify({ sessionId: "session-new" }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            error: {
              code: "multiple_live_batches",
              message: "This file has 2 live import batches for the same underlying content.",
              details: { conflictingBatches: wireConflictingBatches, conflictingBatchesCount: 2 },
            },
          }),
          { status: 422, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    let chunkUpload: ChunkUploadState[] = [{ index: 1, status: "pending", batchId: null, error: null, code: null }];
    const result = await confirmChunkedSession({
      plan: PLAN,
      initialUpload: chunkUpload,
      existingSessionId: null,
      fileLabel: "cellar.csv",
      timestampsRef: { current: [] },
      onSessionId: () => {},
      onProgress: (u) => {
        chunkUpload = u;
      },
    });

    // Sanity: the real mechanism actually produced a one-candidate DISPLAY
    // list while the real count (2) survives, and the chunk stays terminal.
    expect(chunkUpload[0].conflictingBatches).toEqual([wireConflictingBatches[0]]);
    expect(chunkUpload[0].conflictingBatchesCount).toBe(2);
    expect(chunkUpload[0].code).toBe("multiple_live_batches");
    expect(chunkUpload[0].status).toBe("failed");
    expect(result).toMatchObject({ ok: false });
    const expectedMessage = `This file has 2 live import batches for the same underlying content. ${CONFLICT_UNDISPLAYED_NOTE}`;
    // STORED chunk error (what ChunkUploadProgress renders) carries the
    // honest, not-all-displayed copy — never the false "already resolved"
    // wording rounds 17-19 shipped, and never a claim that Recent imports
    // can reach the missing one (round-22 audit BLOCK 2).
    expect(chunkUpload[0].error).toBe(expectedMessage);
    expect(chunkUpload[0].error).not.toMatch(/already (been )?resolved/i);
    expect(chunkUpload[0].error).not.toMatch(/Recent imports/i);

    // Mirrors exactly what ImportClient itself computes from chunkUpload —
    // visibleConflictCandidates drops only a REVERTED id (none here), so
    // the one parseable candidate is still offered a revert button.
    const conflictingBatches = visibleConflictCandidates(chunkUpload[0].conflictingBatches, new Set());
    const conflictingBatchesTruncated =
      (chunkUpload[0].conflictingBatchesTruncated ?? false) ||
      (typeof chunkUpload[0].conflictingBatchesCount === "number" &&
        (chunkUpload[0].conflictingBatches?.length ?? 0) < chunkUpload[0].conflictingBatchesCount);

    const { container } = await mount(
      <PreviewStep
        {...baseProps({
          chunkUpload,
          chunkTotal: 1,
          error: result.ok ? null : result.error,
          conflictingBatches,
          conflictingBatchesTruncated,
        })}
      />,
    );

    const buttons = [...container.querySelectorAll("button")];
    // Genuinely terminal: never offer a doomed Retry, and never Confirm
    // either — the conflict this chunk reported is still real, and no
    // revert has happened yet (hasRevertedAnyConflict defaults to false).
    expect(buttons.some((b) => b.textContent?.includes("Retry upload"))).toBe(false);
    expect(buttons.some((b) => b.textContent?.includes("Confirm import"))).toBe(false);
    // The one parseable candidate IS shown with a revert affordance.
    expect(container.textContent).toContain("Conflicting live imports for this file");
    expect(container.textContent).toContain("cellar.csv");
    expect(buttons.some((b) => /^Revert$/.test(b.textContent ?? ""))).toBe(true);
    // RENDERED copy carries the same honest, not-all-displayed message —
    // never the false "already resolved" wording, never a Recent-imports
    // promise it can't keep.
    expect(container.textContent).toContain(expectedMessage);
    expect(container.textContent).not.toMatch(/already (been )?resolved/i);
  });

  async function mount(element: ReactElement) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => root.render(element));
    return { container, root };
  }
});

// FINDING 3 (round-11 audit): the plain (non-chunked) confirm path used to
// discard the server error CODE entirely (only the message survived), so
// hasTerminalReconciliationConflict — derived only from chunkUpload — could
// never see a plain-path multiple_live_batches or duplicate_race_retry_
// exhausted failure. "Confirm import" rendered forever, retryable with no
// bound. plainConfirmErrorCode carries that code through for chunkUpload ===
// null exactly the way ChunkUploadState.code already does per-chunk.
describe("PreviewStep — plain (non-chunked) path terminal conflicts are blocked too (round-11 audit finding 3)", () => {
  const mountedRoots: Root[] = [];

  afterEach(async () => {
    for (const root of mountedRoots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
  });

  it("hides Confirm import for a plain-path multiple_live_batches conflict", async () => {
    const serverMessage = "This file has 2 live import batches for the same underlying content.";
    const { container } = await mount(
      <PreviewStep
        {...baseProps({ chunkUpload: null, error: serverMessage, plainConfirmErrorCode: "multiple_live_batches" })}
      />,
    );

    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.some((b) => b.textContent?.includes("Confirm import"))).toBe(false);
    expect(container.textContent).toContain(serverMessage);
  });

  it("hides Confirm import for a plain-path duplicate_race_retry_exhausted conflict", async () => {
    const escalationMessage =
      "This upload still conflicts with another live import for this file after 3 attempts — this needs a " +
      "human to resolve. Revert the conflicting batch under Recent imports before uploading this file again.";
    const { container } = await mount(
      <PreviewStep
        {...baseProps({
          chunkUpload: null,
          error: escalationMessage,
          plainConfirmErrorCode: "duplicate_race_retry_exhausted",
        })}
      />,
    );

    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.some((b) => b.textContent?.includes("Confirm import"))).toBe(false);
    expect(container.textContent).toContain(escalationMessage);
  });

  it("still shows Confirm import for an ordinary retryable plain-path failure (e.g. duplicate_race_retry itself)", async () => {
    const { container } = await mount(
      <PreviewStep
        {...baseProps({ chunkUpload: null, error: "Another import attempt is being cleaned up.", plainConfirmErrorCode: "duplicate_race_retry" })}
      />,
    );

    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.some((b) => b.textContent?.includes("Confirm import"))).toBe(true);
  });

  async function mount(element: ReactElement) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => root.render(element));
    return { container, root };
  }
});

// FINDING 2 (round-11 audit): a multiple_live_batches conflict used to name
// only a candidate COUNT, so the operator's only recourse was finding both
// conflicting batches by hand in Recent imports — which shows only the ten
// newest. If both had aged out of that window, the conflict was permanent.
// The conflict panel renders directly from the `conflictingBatches` prop,
// entirely independent of any Recent-imports list, so a batch that has aged
// out of the ten-newest is still fully recoverable here.
describe("PreviewStep — multiple_live_batches conflict panel offers a revert affordance per batch, not tied to Recent imports (round-11 audit finding 2)", () => {
  const mountedRoots: Root[] = [];

  afterEach(async () => {
    for (const root of mountedRoots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
  });

  it("renders a Revert button per conflicting batch and calls onRevertConflict with the right id", async () => {
    const conflictingBatches = [
      { id: "batch-aged-out", filename: "cellar-old.csv", status: "created", created_at: "2020-01-01T00:00:00Z" },
      { id: "batch-recent", filename: "cellar-old.csv", status: "applying", created_at: "2026-01-01T00:00:00Z" },
    ];
    const onRevertConflict = vi.fn();

    const { container } = await mount(
      <PreviewStep
        {...baseProps({
          error: "This file has 2 live import batches for the same underlying content.",
          plainConfirmErrorCode: "multiple_live_batches",
          conflictingBatches,
          onRevertConflict,
        })}
      />,
    );

    // Neither batch needs to appear in any "recent" list for this panel to
    // render them — it is built entirely from the conflictingBatches prop.
    expect(container.textContent).toContain("cellar-old.csv");
    const revertButtons = [...container.querySelectorAll("button")].filter((b) => b.textContent?.includes("Revert"));
    expect(revertButtons).toHaveLength(2);

    // BLOCK 2 (round-13 audit): Revert no longer fires the request
    // directly — it hands the WHOLE candidate to the caller, which opens a
    // confirmation dialog before anything destructive happens.
    await act(async () => revertButtons[0].click());
    expect(onRevertConflict).toHaveBeenCalledWith(conflictingBatches[0]);
  });

  it("renders nothing when there is no conflict", async () => {
    const { container } = await mount(<PreviewStep {...baseProps({ conflictingBatches: [] })} />);
    expect(container.textContent).not.toContain("Conflicting live imports");
  });

  // BLOCK 2 (round-13 audit): the cleanup counts/warning flags a completed
  // conflict-panel revert reported used to be discarded entirely. Rendered
  // with the SAME summarizeRevertResult copy BatchStep's own success panel
  // uses (see the "revertedCount" text below).
  it("renders the cleanup outcome, including a partial-cleanup warning, after a conflict revert completes", async () => {
    const { container } = await mount(
      <PreviewStep
        {...baseProps({
          conflictRevertOutcomes: [
            {
              id: "batch-aged-out",
              filename: "cellar-old.csv",
              result: {
                revertedCount: 4,
                orphanWinesDeleted: 1,
                lwinStampsCleared: 1,
                cleanupTruncated: false,
                orphanCleanupSkipped: false,
                cleanupFailures: 0,
              },
            },
          ],
        })}
      />,
    );

    expect(container.textContent).toContain("cellar-old.csv");
    expect(container.textContent).toContain("Removed 4 inventory row(s)");
  });

  // FINDING 2 (round-15 audit): the existing test above sets every warning
  // flag to false, so it never actually exercises summarizeRevertResult's
  // warning branches — it would pass identically even if those branches
  // were deleted. This one sets a flag TRUE and pins the specific warning
  // copy that must appear because of it.
  it("renders the catalog-cleanup-didn't-finish warning when cleanupTruncated is actually true", async () => {
    const { container } = await mount(
      <PreviewStep
        {...baseProps({
          conflictRevertOutcomes: [
            {
              id: "batch-aged-out",
              filename: "cellar-old.csv",
              result: {
                revertedCount: 4,
                orphanWinesDeleted: 1,
                lwinStampsCleared: 1,
                cleanupTruncated: true,
                orphanCleanupSkipped: false,
                cleanupFailures: 0,
              },
            },
          ],
        })}
      />,
    );

    expect(container.textContent).toContain("Catalog cleanup didn't finish in time and was left partial");
  });

  async function mount(element: ReactElement) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => root.render(element));
    return { container, root };
  }
});

// WARN 6 (round-13 audit): the old tests injected conflict data straight
// into PreviewStep's props and asserted only that a callback received an
// id — they never actually executed handleRevertConflict, never tested
// 2xx/409/404 behaviour, never verified cleanup warnings, and never proved
// Confirm/Retry becomes reachable again. This is the test that proves
// BLOCK 1 (a resolved conflict actually clears the terminal
// multiple_live_batches code) and BLOCK 2 (Revert routes through a real
// confirmation and reports cleanup counts/warnings) are actually fixed —
// driven through the real, mounted ImportClient, not a hand-built prop
// fixture, with `fetch` stubbed exactly like BatchStep's own applyAll
// tests above.
// Round-23 audit (SIMPLIFY): rewritten from the ground up. The old round-13
// suite proved a revert LOCALLY clears the conflict once the count hits its
// threshold — exactly the mechanism three later audits (rounds 18, 20, 22)
// each found a fresh way to get wrong. The new contract: a successful
// revert drops that candidate from the panel and exposes a retry
// affordance, but never by itself grants success — only the SERVER'S next
// response decides whether Confirm/Retry actually succeeds.
describe("ImportClient — a conflict revert exposes Retry, and only the SERVER decides when the conflict is gone (round-23 audit — SIMPLIFY)", () => {
  const mountedRoots: Root[] = [];

  afterEach(async () => {
    for (const root of mountedRoots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
    document.body.style.overflow = "";
    vi.unstubAllGlobals();
  });

  const CSV_CONTENT = `${CANONICAL_HEADERS.join(",")}\nDomaine Example,Cuvee One,2020,Pinot Noir,Burgundy,France,750,,USD,6,24.50,,\n`;

  const CONFLICT_ERROR_BODY = {
    error: {
      code: "multiple_live_batches",
      message:
        "This file has 2 live import batches for the same underlying content — this can't be resolved " +
        "automatically. Revert all but one of them below before resuming or re-uploading this file.",
      details: {
        conflictingBatches: [
          { id: "conflict-1", filename: "cellar-old.csv", status: "created", created_at: "2020-01-01T00:00:00.000Z" },
          { id: "conflict-2", filename: "cellar-old.csv", status: "applying", created_at: "2021-01-01T00:00:00.000Z" },
        ],
        conflictingBatchesCount: 2,
      },
    },
  };

  const PREVIEW_SUCCESS_BODY = {
    rows: [],
    summary: {
      totalRows: 1,
      validRows: 1,
      errorRows: 0,
      matchedRows: 1,
      unmatchedRows: 0,
      missingCostRows: 0,
      readyToApplyRows: 1,
      pendingResolutionRows: 0,
    },
  };

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  /** Drives a freshly-mounted ImportClient from the upload step through to
   * the multiple_live_batches conflict panel: selects a valid one-row CSV,
   * clicks Preview, then Confirm. */
  async function reachConflictPanel(container: HTMLElement, filename = "cellar.csv") {
    const file = new File([CSV_CONTENT], filename, { type: "text/csv" });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("Could not find the file input");
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));

    const previewButton = findButton(container, "Preview import");
    if (!previewButton) throw new Error("Could not find Preview import button");
    await act(async () => previewButton.click());

    const confirmButton = findButton(container, "Confirm import");
    if (!confirmButton) throw new Error("Could not find Confirm import button");
    await act(async () => confirmButton.click());
  }

  /** Returns the stubbed fetch mock so a test can inspect exactly which
   * requests were actually sent. `confirmResponses` is consumed in order by
   * successive POST /api/import/batches calls (repeated indefinitely once
   * exhausted, using the last entry) — letting a test script "still
   * conflicting" vs. "now succeeds" across a revert-then-retry sequence.
   * `revertHandler` answers every `/api/import/batches/<id>/revert` call. */
  function stubFetch(
    confirmResponses: Response[],
    revertHandler: (url: string, init?: RequestInit) => Promise<Response>,
  ) {
    let confirmCallIndex = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/import/batches" && method === "GET") return jsonResponse(200, { batches: [] });
      if (url === "/api/import/preview" && method === "POST") return jsonResponse(200, PREVIEW_SUCCESS_BODY);
      if (url === "/api/import/batches" && method === "POST") {
        const response = confirmResponses[Math.min(confirmCallIndex, confirmResponses.length - 1)];
        confirmCallIndex += 1;
        return response;
      }
      if (/^\/api\/import\/batches\/[^/]+\/revert$/.test(url) && method === "POST") return revertHandler(url, init);
      if (/^\/api\/import\/batches\/[^/]+$/.test(url) && method === "GET") {
        return jsonResponse(200, {
          batch: {
            id: "new-batch",
            filename: "cellar.csv",
            status: "created",
            total_rows: 1,
            created_at: "2026-01-01T00:00:00.000Z",
            reverted_at: null,
          },
          rows: [],
        });
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("a 2xx revert drops that candidate, keeps a still-live survivor listed, and exposes Retry — the import proceeds only once the server actually reports success", async () => {
    const fetchMock = stubFetch(
      [jsonResponse(422, CONFLICT_ERROR_BODY), jsonResponse(201, { batchId: "new-batch", alreadyExists: false, totalRows: 1, summary: PREVIEW_SUCCESS_BODY.summary })],
      async () =>
        jsonResponse(200, {
          revertedCount: 4,
          orphanWinesDeleted: 1,
          lwinStampsCleared: 1,
          cleanupTruncated: false,
          orphanCleanupSkipped: false,
          cleanupFailures: 0,
        }),
    );

    const { container } = await mount(<ImportClient />);
    await reachConflictPanel(container);

    // Terminal conflict: Confirm import is gone, the conflict panel shows
    // BOTH real candidates.
    expect(findButton(container, "Confirm import")).toBeFalsy();
    expect(container.textContent).toContain("Conflicting live imports for this file");
    let revertButtons = [...container.querySelectorAll("button")].filter((b) => /^Revert$/.test(b.textContent ?? ""));
    expect(revertButtons).toHaveLength(2);

    await act(async () => revertButtons[0].click());
    // BLOCK 2 (round-13 audit): no request goes out until the confirmation
    // dialog is confirmed — the dialog's own button, not the panel's
    // "Revert".
    expect(container.textContent).toContain("Revert this import?");
    expect(fetchMock.mock.calls.some(([u]) => /\/revert$/.test(String(u)))).toBe(false);
    await act(async () => findButton(container, /^Revert import$/)!.click());
    expect(fetchMock.mock.calls.filter(([u]) => /\/revert$/.test(String(u)))).toHaveLength(1);

    // Round-23 audit (SIMPLIFY): reverting conflict-1 does NOT clear the
    // conflict locally — conflict-2 is STILL a live, unresolved candidate
    // as far as this client knows, so the panel still names it and still
    // offers it a Revert button. What DOES change is that a retry
    // affordance is now available, because the operator has done
    // something about the conflict.
    expect(container.textContent).toContain("Conflicting live imports for this file");
    expect(container.textContent).toContain("cellar-old.csv");
    revertButtons = [...container.querySelectorAll("button")].filter((b) => /^Revert$/.test(b.textContent ?? ""));
    expect(revertButtons).toHaveLength(1);
    const retryButton = findButton(container, "Confirm import");
    expect(retryButton).toBeTruthy();
    // BLOCK 2: the cleanup counts/warnings a 2xx reports are surfaced, not
    // discarded — same copy BatchStep's own success panel uses.
    expect(container.textContent).toContain("Removed 4 inventory row(s)");

    // Clicking Retry re-sends the confirm request — the SECOND stubbed
    // response is a real 201, proving the import only proceeds because the
    // SERVER said so, not because of anything counted or decremented here.
    await act(async () => retryButton!.click());
    expect(fetchMock.mock.calls.filter(([u, i]) => String(u) === "/api/import/batches" && (i as RequestInit)?.method === "POST")).toHaveLength(2);
    expect(container.textContent).not.toContain("Conflicting live imports for this file");
    // Reached the batch step — BatchStep's own "Revert this import" control
    // only renders there.
    expect(container.textContent).toContain("Revert this import");
  });

  it("a 409 (already reverted) drops the candidate and exposes Retry, with no cleanup outcome to show", async () => {
    stubFetch(
      [jsonResponse(422, CONFLICT_ERROR_BODY)],
      async () => jsonResponse(409, { error: { code: "not_completed", message: "Import batch is already reverted." } }),
    );

    const { container } = await mount(<ImportClient />);
    await reachConflictPanel(container);
    expect(findButton(container, "Confirm import")).toBeFalsy();

    await act(async () => findButton(container, /^Revert$/)!.click());
    await act(async () => findButton(container, /^Revert import$/)!.click());

    // BLOCK 1 (round-13 audit): a 409 from THIS endpoint only ever means
    // "already reverted" — the desired end state was already reached —
    // so it counts as a completed revert exactly like a 2xx would: the
    // candidate drops out of the panel and Retry becomes available. The
    // terminal conflict message/code themselves are untouched (still real
    // as far as this client knows) — retrying is what actually checks.
    expect(container.textContent).toContain("Conflicting live imports for this file");
    expect([...container.querySelectorAll("button")].filter((b) => /^Revert$/.test(b.textContent ?? ""))).toHaveLength(1);
    expect(findButton(container, "Confirm import")).toBeTruthy();
    expect(container.textContent).not.toContain("Removed");
  });

  it("a 404 (already gone) drops the candidate and exposes Retry, with no cleanup outcome to show", async () => {
    stubFetch(
      [jsonResponse(422, CONFLICT_ERROR_BODY)],
      async () => jsonResponse(404, { error: { code: "not_found", message: "Import batch not found." } }),
    );

    const { container } = await mount(<ImportClient />);
    await reachConflictPanel(container);
    expect(findButton(container, "Confirm import")).toBeFalsy();

    await act(async () => findButton(container, /^Revert$/)!.click());
    await act(async () => findButton(container, /^Revert import$/)!.click());

    // BLOCK 1: a 404 means the batch no longer exists — also the desired
    // end state — so it counts as a completed revert too.
    expect([...container.querySelectorAll("button")].filter((b) => /^Revert$/.test(b.textContent ?? ""))).toHaveLength(1);
    expect(findButton(container, "Confirm import")).toBeTruthy();
    expect(container.textContent).not.toContain("Removed");
  });

  it("a genuine revert failure (500) keeps the candidate listed and never opens the way back to Confirm import", async () => {
    stubFetch(
      [jsonResponse(422, CONFLICT_ERROR_BODY)],
      async () => jsonResponse(500, { error: { code: "internal_error", message: "Something went wrong." } }),
    );

    const { container } = await mount(<ImportClient />);
    await reachConflictPanel(container);

    await act(async () => findButton(container, /^Revert$/)!.click());
    await act(async () => findButton(container, /^Revert import$/)!.click());

    // An actual failure (not 409/404) never counts as a completed revert —
    // the candidate stays listed, and no retry affordance opens up.
    expect(container.textContent).toContain("Conflicting live imports for this file");
    expect([...container.querySelectorAll("button")].filter((b) => /^Revert$/.test(b.textContent ?? ""))).toHaveLength(2);
    expect(findButton(container, "Confirm import")).toBeFalsy();
    expect(container.textContent).toContain("Something went wrong.");
  });

  // FINDING 3 (round-15 audit), extended round-23: reset() must clear every
  // piece of conflict-revert state — not just conflictRevertOutcomes, but
  // also the new revertedConflictBatchIds/hasRevertedAnyConflict — or a
  // NEXT, wholly unrelated file's fresh conflict would inherit "the
  // operator already reverted something" and show Retry with zero reverts
  // actually done against IT.
  it("starting a new import (Choose a different file) clears the previous conflict's revert state — the NEXT file's conflict starts blocked again", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/import/batches" && method === "GET") return jsonResponse(200, { batches: [] });
      if (url === "/api/import/preview" && method === "POST") return jsonResponse(200, PREVIEW_SUCCESS_BODY);
      if (url === "/api/import/batches" && method === "POST") {
        // Every confirm attempt, for EITHER file, hits the same conflict —
        // this test is about the client's own revert-tracking state, not
        // about ever reaching success.
        return jsonResponse(422, CONFLICT_ERROR_BODY);
      }
      if (/^\/api\/import\/batches\/[^/]+\/revert$/.test(url) && method === "POST") {
        return jsonResponse(200, {
          revertedCount: 4,
          orphanWinesDeleted: 1,
          lwinStampsCleared: 1,
          cleanupTruncated: false,
          orphanCleanupSkipped: false,
          cleanupFailures: 0,
        });
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = await mount(<ImportClient />);
    await reachConflictPanel(container);
    await act(async () => findButton(container, /^Revert$/)!.click());
    await act(async () => findButton(container, /^Revert import$/)!.click());
    expect(container.textContent).toContain("Removed 4 inventory row(s)");
    expect(findButton(container, "Confirm import")).toBeTruthy();

    // "Choose a different file" is PreviewStep's onBack, wired to reset().
    await act(async () => findButton(container, "Choose a different file")!.click());

    await reachConflictPanel(container, "cellar-2.csv");

    // The NEW file's preview must not still show the PREVIOUS file's
    // cleanup result, AND must not have inherited a retry affordance it
    // never earned — no revert has happened against THIS conflict yet.
    expect(container.textContent).not.toContain("Removed 4 inventory row(s)");
    expect(findButton(container, "Confirm import")).toBeFalsy();
    expect(container.textContent).toContain("Conflicting live imports for this file");
  });

  // Round-23 audit (TESTS — round-22 audit WARN 4): the capped 21-live-
  // batches shape explicitly. LIVE_BATCH_LOOKUP_LIMIT caps the server's own
  // read at 20 candidates — conflictingBatchesCount (20) equals the
  // displayed array's length even though a 21st, undisplayable candidate
  // is genuinely live (conflictingBatchesTruncated: true is the only signal
  // that says so — round-22 audit BLOCK 2). Reverting every SHOWN candidate
  // must never by itself unblock the import: only the server's own answer
  // on a later confirm attempt does that.
  it("reverting every displayed candidate of a capped 21-live-batches conflict never by itself unblocks the import — only the server's own answer does", async () => {
    const candidates = Array.from({ length: 20 }, (_, i) => ({
      id: `conflict-${i}`,
      filename: "cellar-old.csv",
      status: "created",
      created_at: `2020-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
    }));
    const CAPPED_CONFLICT_BODY = {
      error: {
        code: "multiple_live_batches",
        message: "This file has at least 20 live import batches for the same underlying content.",
        details: { conflictingBatches: candidates, conflictingBatchesCount: 20, conflictingBatchesTruncated: true },
      },
    };

    let confirmCallCount = 0;
    const revertedIds: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/import/batches" && method === "GET") return jsonResponse(200, { batches: [] });
      if (url === "/api/import/preview" && method === "POST") return jsonResponse(200, PREVIEW_SUCCESS_BODY);
      if (url === "/api/import/batches" && method === "POST") {
        confirmCallCount += 1;
        // ALWAYS still-conflicting, regardless of how many candidates this
        // client has reverted — proving nothing client-side ever
        // manufactures success out of local revert bookkeeping.
        return jsonResponse(422, CAPPED_CONFLICT_BODY);
      }
      const revertMatch = url.match(/^\/api\/import\/batches\/([^/]+)\/revert$/);
      if (revertMatch && method === "POST") {
        revertedIds.push(revertMatch[1]);
        return jsonResponse(200, {
          revertedCount: 1,
          orphanWinesDeleted: 0,
          lwinStampsCleared: 0,
          cleanupTruncated: false,
          orphanCleanupSkipped: false,
          cleanupFailures: 0,
        });
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = await mount(<ImportClient />);
    await reachConflictPanel(container);

    // Round-22 audit BLOCK 2: the honest "not everything could be shown"
    // note fires purely from the server's own conflictingBatchesTruncated
    // flag — candidates.length (20) equals conflictingBatchesCount (20)
    // here, so the OLD count-vs-array-length check alone would have missed
    // this entirely. Copy names no specific count (correct for the 1+
    // candidates beyond the cap, whatever that number actually is).
    expect(container.textContent).toContain(CONFLICT_UNDISPLAYED_NOTE);

    // Revert every displayed candidate, one at a time, through the real
    // confirmation-dialog flow.
    for (let i = 0; i < candidates.length; i++) {
      const revertButtons = [...container.querySelectorAll("button")].filter((b) => /^Revert$/.test(b.textContent ?? ""));
      expect(revertButtons.length).toBeGreaterThan(0);
      await act(async () => revertButtons[0].click());
      await act(async () => findButton(container, /^Revert import$/)!.click());
    }
    expect(revertedIds).toHaveLength(20);

    // Every displayed candidate is gone from the panel — but Retry has
    // been available since the FIRST successful revert, not because a
    // count reached zero (there is no count-based gate left to reach).
    expect([...container.querySelectorAll("button")].filter((b) => /^Revert$/.test(b.textContent ?? ""))).toHaveLength(0);
    const retryButton = findButton(container, "Confirm import");
    expect(retryButton).toBeTruthy();

    // Clicking Retry re-sends to the server, which reports the EXACT same
    // capped conflict again — proving reverting every displayed candidate
    // never by itself resolved anything. Retry stays available (the
    // operator has still done something about it), so this is a real,
    // repeatable loop, never a dead end.
    await act(async () => retryButton!.click());
    expect(confirmCallCount).toBe(2);
    expect(container.textContent).toContain("This file has at least 20 live import batches");
    expect(findButton(container, "Confirm import")).toBeTruthy();
  });

  // ROUND-21 AUDIT CORRECTION, carried forward round-23 (SIMPLIFY): a
  // multiple_live_batches conflict PARSED down to one candidate via a
  // malformed sibling entry is not "resolved" — nothing decrements or
  // infers from it. It stays exactly as blocked as a genuine two-candidate
  // conflict until the operator actually reverts something.
  it("a conflict that parses down to one candidate via a malformed sibling entry stays blocked, shows the one parseable candidate, and states honestly that not everything could be displayed", async () => {
    const wireConflictingBatches = [
      { id: "conflict-1", filename: "cellar-old.csv", status: "created", created_at: "2020-01-01T00:00:00.000Z" },
      { id: "conflict-2", filename: "cellar-old.csv", status: "applying" }, // malformed: no created_at
    ];
    const serverMessage =
      "This file has 2 live import batches for the same underlying content — this can't be resolved " +
      "automatically. Revert all but one of them below before resuming or re-uploading this file.";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/import/batches" && method === "GET") return jsonResponse(200, { batches: [] });
        if (url === "/api/import/preview" && method === "POST") return jsonResponse(200, PREVIEW_SUCCESS_BODY);
        if (url === "/api/import/batches" && method === "POST") {
          return jsonResponse(422, {
            error: {
              code: "multiple_live_batches",
              message: serverMessage,
              details: { conflictingBatches: wireConflictingBatches, conflictingBatchesCount: 2 },
            },
          });
        }
        throw new Error(`unexpected fetch ${method} ${url}`);
      }),
    );

    const { container } = await mount(<ImportClient />);
    await reachConflictPanel(container);

    // The conflict is still real: Confirm import stays hidden (no revert
    // has happened yet), and the panel shows the ONE candidate that could
    // be parsed, with a revert affordance — the malformed second entry
    // never reverted anything.
    expect(findButton(container, "Confirm import")).toBeFalsy();
    expect(container.textContent).toContain("Conflicting live imports for this file");
    expect(container.textContent).toContain("cellar-old.csv");
    const revertButtons = [...container.querySelectorAll("button")].filter((b) => /^Revert$/.test(b.textContent ?? ""));
    expect(revertButtons).toHaveLength(1);
    // RENDERED copy carries the server's own message plus an honest note
    // that not everything could be displayed — never the false "already
    // resolved" wording rounds 17-19 shipped, and never a claim that
    // Recent imports can reach the missing one (round-22 audit BLOCK 2).
    const expectedMessage = `${serverMessage} ${CONFLICT_UNDISPLAYED_NOTE}`;
    expect(container.textContent).toContain(expectedMessage);
    expect(container.textContent).not.toMatch(/already (been )?resolved/i);
  });

  async function mount(element: ReactElement) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => root.render(element));
    return { container, root };
  }
});

describe("PreviewStep — duplicate_chunk_content is recoverable, not a dead end (round-4 audit finding 2)", () => {
  const mountedRoots: Root[] = [];

  afterEach(async () => {
    for (const root of mountedRoots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
  });

  // Round-6 audit finding 3: the guidance text was reworded — a genuine
  // repeated segment routes through "Import anyway" (the deterministic
  // no-op override), not through inventing a row edit that "actually
  // DIFFERS" from the sibling's own value.
  it("hides the Confirm/Retry button and renders honest guidance naming the other chunk and Import anyway, before anything is fixed", async () => {
    const chunkUpload: ChunkUploadState[] = [
      {
        index: 1,
        status: "failed",
        batchId: null,
        error:
          "Chunk 1's content is identical to chunk 2, already imported in this session — the database can't hold " +
          "two imports with identical content. If this is a genuine repeated segment that needs to import again, " +
          'use "Import anyway" below to import it as a separate tracked upload. If the duplication was accidental, ' +
          'no action is needed, or use "Skip this chunk" below — chunk 2 already imported these rows.',
        code: "duplicate_chunk_content",
      },
    ];

    const { container } = await mount(
      <PreviewStep
        {...baseProps({
          chunkUpload,
          chunkTotal: 2,
          error: chunkUpload[0].error,
          errorRows: [errorRow(1, { chunkIndex: 1, chunkRowNumber: 1 })],
        })}
      />,
    );

    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.some((b) => b.textContent?.includes("Retry upload"))).toBe(false);
    expect(buttons.some((b) => b.textContent?.includes("Confirm import"))).toBe(false);
    expect(container.textContent).toContain("identical to chunk 2");
    expect(container.textContent).toContain("Import anyway");
    expect(container.textContent).not.toContain("actually DIFFERS");
  });

  // Round-5 audit finding 3: the gate used to check only that an override
  // EXISTS for the failed chunk's own row — two identical chunks given the
  // exact SAME inline fix hash identically every time, so this would
  // (wrongly) offer Retry forever without the fix ever actually resolving
  // the collision. The gate now compares the CURRENT override against the
  // slice that was actually SENT with the failed attempt
  // (sentOverridesSnapshot) — only a genuine change re-enables Retry.
  it("keeps the Retry button HIDDEN when the current override is UNCHANGED from what was already sent and failed", async () => {
    const chunkUpload: ChunkUploadState[] = [
      {
        index: 1,
        status: "failed",
        batchId: null,
        error: "Chunk 1's content is identical to chunk 2.",
        code: "duplicate_chunk_content",
        sentOverridesSnapshot: { 1: { quantity: "6" } },
      },
    ];

    const { container } = await mount(
      <PreviewStep
        {...baseProps({
          chunkUpload,
          chunkTotal: 2,
          chunkBreakdown: [{ index: 1, startRow: 1, endRow: 1, summary: ZERO_SUMMARY }],
          error: chunkUpload[0].error,
          errorRows: [errorRow(1, { chunkIndex: 1, chunkRowNumber: 1 })],
          // Same value the failed attempt already sent — the SAME
          // canonical overrides JSON server-side, hence the SAME digest,
          // hence the SAME collision. Retry must stay hidden.
          rowOverrides: { 1: { quantity: "6" } },
        })}
      />,
    );

    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.some((b) => b.textContent?.includes("Retry upload"))).toBe(false);
    expect(buttons.some((b) => b.textContent?.includes("Confirm import"))).toBe(false);
  });

  it("shows the Retry button once the current override DIFFERS from what was already sent and failed", async () => {
    const chunkUpload: ChunkUploadState[] = [
      {
        index: 1,
        status: "failed",
        batchId: null,
        error: "Chunk 1's content is identical to chunk 2.",
        code: "duplicate_chunk_content",
        sentOverridesSnapshot: { 1: { quantity: "6" } },
      },
    ];

    const { container } = await mount(
      <PreviewStep
        {...baseProps({
          chunkUpload,
          chunkTotal: 2,
          chunkBreakdown: [{ index: 1, startRow: 1, endRow: 1, summary: ZERO_SUMMARY }],
          error: chunkUpload[0].error,
          errorRows: [errorRow(1, { chunkIndex: 1, chunkRowNumber: 1 })],
          // A genuinely different value from what was already sent.
          rowOverrides: { 1: { quantity: "7" } },
        })}
      />,
    );

    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.some((b) => b.textContent?.includes("Retry upload"))).toBe(true);
  });

  it("does NOT re-enable the button for an override on a DIFFERENT row than the failed chunk's own", async () => {
    const chunkUpload: ChunkUploadState[] = [
      { index: 1, status: "failed", batchId: null, error: "Chunk 1's content is identical to chunk 2.", code: "duplicate_chunk_content" },
    ];

    const { container } = await mount(
      <PreviewStep
        {...baseProps({
          chunkUpload,
          chunkTotal: 2,
          chunkBreakdown: [
            { index: 1, startRow: 1, endRow: 1, summary: ZERO_SUMMARY },
            { index: 3, startRow: 5, endRow: 5, summary: ZERO_SUMMARY },
          ],
          error: chunkUpload[0].error,
          // Row 5 belongs to a DIFFERENT chunk (chunkIndex 3) — fixing it
          // says nothing about chunk 1's own content.
          errorRows: [errorRow(5, { chunkIndex: 3, chunkRowNumber: 1 })],
          rowOverrides: { 5: { quantity: "6" } },
        })}
      />,
    );

    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.some((b) => b.textContent?.includes("Retry upload"))).toBe(false);
    expect(buttons.some((b) => b.textContent?.includes("Confirm import"))).toBe(false);
  });

  // Round-6 audit finding 3: "Import anyway" produces a no-op override on
  // the chunk's FIRST data row, which for a fully-valid duplicate chunk is
  // not an error row at all — it would never appear in errorRows, so the
  // gate above must find it via chunkBreakdown's own row range, not by
  // matching against errorRows.
  it("re-enables the button for a no-op override on a row that ISN'T an error row (the 'Import anyway' shape)", async () => {
    const chunkUpload: ChunkUploadState[] = [
      { index: 1, status: "failed", batchId: null, error: "Chunk 1's content is identical to chunk 2.", code: "duplicate_chunk_content" },
    ];

    const { container } = await mount(
      <PreviewStep
        {...baseProps({
          chunkUpload,
          chunkTotal: 2,
          chunkBreakdown: [{ index: 1, startRow: 1, endRow: 2, summary: ZERO_SUMMARY }],
          error: chunkUpload[0].error,
          errorRows: [], // fully valid chunk — no error row at all
          // "Import anyway"'s own shape: an override on the chunk's first
          // data row (global row 1), which has no entry in errorRows.
          rowOverrides: { 1: { producer: "Domaine" } },
        })}
      />,
    );

    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.some((b) => b.textContent?.includes("Retry upload"))).toBe(true);
  });

  // Round-5 audit finding 4: a fully VALID duplicate chunk (no error rows
  // at all) has no override to ever enter — Retry can never re-enable, and
  // without an escape hatch the whole multi-chunk upload is stuck forever
  // (blocksConfirmButton hides Confirm/Retry site-wide, not just for this
  // chunk). "Skip this chunk" is the escape hatch: it's client-side only
  // and unblocks the rest of the upload.
  describe("Skip this chunk (round-5 audit finding 4)", () => {
    it("offers a Skip control for a duplicate_chunk_content chunk with NO error rows of its own, and calling it unblocks Confirm/Retry", async () => {
      const chunkUpload: ChunkUploadState[] = [
        { index: 1, status: "failed", batchId: null, error: "Chunk 1's content is identical to chunk 2.", code: "duplicate_chunk_content" },
        { index: 2, status: "confirmed", batchId: "b2", error: null, code: null },
      ];
      let skippedIndex: number | null = null;

      const { container } = await mount(
        <PreviewStep
          {...baseProps({
            chunkUpload,
            chunkTotal: 2,
            error: chunkUpload[0].error,
            errorRows: [], // fully valid chunk — no row to edit at all
            onSkipChunk: (index) => {
              skippedIndex = index;
            },
          })}
        />,
      );

      const skipButton = findButton(container, "Skip this chunk");
      expect(skipButton).toBeTruthy();
      expect(container.querySelectorAll("button").length).toBeGreaterThan(0);
      // Confirm/Retry stays hidden until the skip is actually applied —
      // this only pins that the control exists and reports the right index.
      await click(skipButton!);
      expect(skippedIndex).toBe(1);
    });

    it("a chunk marked 'skipped' no longer blocks the Confirm/Retry button for the rest of the upload", async () => {
      const chunkUpload: ChunkUploadState[] = [
        { index: 1, status: "skipped", batchId: null, error: null, code: null, duplicateOfChunkIndex: 2 },
        { index: 2, status: "confirmed", batchId: "b2", error: null, code: null },
      ];

      const { container } = await mount(
        <PreviewStep
          {...baseProps({
            chunkUpload,
            chunkTotal: 2,
            errorRows: [],
            summary: { ...ZERO_SUMMARY, totalRows: 1, validRows: 1, readyToApplyRows: 1 },
          })}
        />,
      );

      const buttons = [...container.querySelectorAll("button")];
      expect(buttons.some((b) => b.textContent?.includes("Confirm import") || b.textContent?.includes("Retry upload"))).toBe(true);
      expect(container.textContent).toContain("Skipped");
    });
  });

  // Round-6 audit finding 3: "Import anyway" — the other action offered
  // alongside Skip on a duplicate_chunk_content chunk.
  describe("Import anyway (round-6 audit finding 3)", () => {
    it("offers an Import anyway control for a duplicate_chunk_content chunk and reports the right index when clicked", async () => {
      const chunkUpload: ChunkUploadState[] = [
        { index: 1, status: "failed", batchId: null, error: "Chunk 1's content is identical to chunk 2.", code: "duplicate_chunk_content" },
        { index: 2, status: "confirmed", batchId: "b2", error: null, code: null },
      ];
      let importedAnywayIndex: number | null = null;

      const { container } = await mount(
        <PreviewStep
          {...baseProps({
            chunkUpload,
            chunkTotal: 2,
            error: chunkUpload[0].error,
            errorRows: [], // fully valid chunk — Import anyway is the ONLY escape hatch
            onImportAnyway: (index) => {
              importedAnywayIndex = index;
            },
          })}
        />,
      );

      const importAnywayButton = findButton(container, "Import anyway");
      expect(importAnywayButton).toBeTruthy();
      await click(importAnywayButton!);
      expect(importedAnywayIndex).toBe(1);
    });

    it("offers BOTH Import anyway and Skip on the same duplicate_chunk_content chunk", async () => {
      const chunkUpload: ChunkUploadState[] = [
        { index: 1, status: "failed", batchId: null, error: "Chunk 1's content is identical to chunk 2.", code: "duplicate_chunk_content" },
      ];

      const { container } = await mount(
        <PreviewStep
          {...baseProps({
            chunkUpload,
            chunkTotal: 1,
            error: chunkUpload[0].error,
            errorRows: [],
            onImportAnyway: () => {},
            onSkipChunk: () => {},
          })}
        />,
      );

      expect(findButton(container, "Import anyway")).toBeTruthy();
      expect(findButton(container, "Skip this chunk")).toBeTruthy();
    });
  });

  // Round-6 audit finding 5: "Undo skip" — skip is trivially reversible
  // client-side state, restoring the failed state with both actions back.
  //
  // Round-7 audit finding 6: the original version of this test was canned
  // — its fixture set `code: null` on the skipped chunk, which contradicts
  // the actual preserved-error/code behavior (skipChunk never clears
  // code — a skipped chunk that came from duplicate_chunk_content keeps
  // that code, exactly so undoSkipChunk can restore the real failed state
  // without reconstructing anything), and it only ever asserted that a
  // callback fired with the right index — never that the UI actually
  // transitions. Replaced with a REAL skip -> undo round trip: a small
  // stateful harness wires PreviewStep's onSkipChunk/onUndoSkip to the
  // real skipChunk/undoSkipChunk pure functions (import-client.tsx) and
  // re-renders on each click, so this pins the actual rendered transition
  // — both actions AND the "Passing validation" count returning to their
  // pre-skip state — not a hand-authored intermediate fixture.
  describe("Skip -> Undo skip round trip through rendered state (round-7 audit finding 6)", () => {
    const CHUNK_BREAKDOWN = [
      { index: 1, startRow: 1, endRow: 2, summary: { ...ZERO_SUMMARY, totalRows: 2, validRows: 2 } },
      { index: 2, startRow: 3, endRow: 4, summary: { ...ZERO_SUMMARY, totalRows: 2, validRows: 2 } },
    ];
    const INITIAL_UPLOAD: ChunkUploadState[] = [
      {
        index: 1,
        status: "failed",
        batchId: null,
        error: "Chunk 1's content is identical to chunk 2, already imported in this session.",
        code: "duplicate_chunk_content",
        duplicateOfChunkIndex: 2,
      },
      { index: 2, status: "confirmed", batchId: "b2", error: null, code: null },
    ];

    function Harness() {
      const [chunkUpload, setChunkUpload] = useState<ChunkUploadState[]>(INITIAL_UPLOAD);
      return (
        <PreviewStep
          {...baseProps({
            summary: { ...ZERO_SUMMARY, totalRows: 4, validRows: 4 },
            errorRows: [], // fully valid duplicate chunk — no inline editor at all
            chunkBreakdown: CHUNK_BREAKDOWN,
            chunkTotal: 2,
            chunkUpload,
            onSkipChunk: (index) => setChunkUpload((prev) => skipChunk(prev, index)),
            onUndoSkip: (index) => setChunkUpload((prev) => undoSkipChunk(prev, index)),
            onImportAnyway: () => {},
          })}
        />
      );
    }

    it("transitions failed -> skipped -> failed through real clicks, restoring both the actions and the Passing validation count", async () => {
      const { container } = await mount(<Harness />);
      const stats = () =>
        new Map([...container.querySelectorAll("dt")].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]));

      // Starting state: chunk 1 failed on duplicate_chunk_content, both
      // escape hatches offered, full aggregate counted.
      expect(findButton(container, "Skip this chunk")).toBeTruthy();
      expect(findButton(container, "Import anyway")).toBeTruthy();
      expect(findButton(container, "Undo skip")).toBeFalsy();
      expect(stats().get("Passing validation")).toBe("4");

      await click(findButton(container, "Skip this chunk")!);

      // After skip: chunk 1's own 2 valid rows drop out of the aggregate,
      // Skip/Import-anyway are replaced by Undo skip, and the honest
      // "identical to chunk 2" summary renders.
      expect(container.textContent).toContain("Skipped — identical to chunk 2, already imported");
      expect(findButton(container, "Skip this chunk")).toBeFalsy();
      expect(findButton(container, "Import anyway")).toBeFalsy();
      expect(findButton(container, "Undo skip")).toBeTruthy();
      expect(stats().get("Passing validation")).toBe("2");

      await click(findButton(container, "Undo skip")!);

      // After undo: back to the EXACT original failed state — both
      // actions return, the error text is preserved, and the count is
      // restored to the full aggregate.
      expect(findButton(container, "Skip this chunk")).toBeTruthy();
      expect(findButton(container, "Import anyway")).toBeTruthy();
      expect(findButton(container, "Undo skip")).toBeFalsy();
      expect(container.textContent).toContain("Chunk 1's content is identical to chunk 2, already imported in this session.");
      expect(stats().get("Passing validation")).toBe("4");
    });

    it("never renders Undo skip for a chunk that isn't skipped", async () => {
      const chunkUpload: ChunkUploadState[] = [
        { index: 1, status: "failed", batchId: null, error: "Chunk 1's content is identical to chunk 2.", code: "duplicate_chunk_content" },
      ];

      const { container } = await mount(
        <PreviewStep
          {...baseProps({
            chunkUpload,
            chunkTotal: 1,
            error: chunkUpload[0].error,
            errorRows: [],
            onUndoSkip: () => {},
          })}
        />,
      );

      expect(findButton(container, "Undo skip")).toBeFalsy();
    });
  });

  // Round-7 audit finding 4: a mid-retry click on Skip/Undo-skip/Import-
  // anyway is overwritten by the driver's next progress write — the same
  // race RowFixItem's own `frozen` prop already closes for row-edit
  // inputs. All three chunk actions freeze too, for the same reason,
  // whenever `confirming` is true.
  describe("chunk actions freeze while a confirm attempt is in flight (round-7 audit finding 4)", () => {
    it("disables Skip, Undo skip, and Import anyway while confirming is true", async () => {
      const chunkUpload: ChunkUploadState[] = [
        { index: 1, status: "failed", batchId: null, error: "conflict", code: "duplicate_chunk_content" },
        { index: 2, status: "skipped", batchId: null, error: null, code: null },
      ];

      const { container } = await mount(
        <PreviewStep
          {...baseProps({
            chunkUpload,
            chunkTotal: 2,
            errorRows: [],
            confirming: true,
            onSkipChunk: () => {},
            onImportAnyway: () => {},
            onUndoSkip: () => {},
          })}
        />,
      );

      expect(findButton(container, "Skip this chunk")?.disabled).toBe(true);
      expect(findButton(container, "Import anyway")?.disabled).toBe(true);
      expect(findButton(container, "Undo skip")?.disabled).toBe(true);
    });

    it("leaves Skip, Undo skip, and Import anyway enabled once confirming is false", async () => {
      const chunkUpload: ChunkUploadState[] = [
        { index: 1, status: "failed", batchId: null, error: "conflict", code: "duplicate_chunk_content" },
        { index: 2, status: "skipped", batchId: null, error: null, code: null },
      ];

      const { container } = await mount(
        <PreviewStep
          {...baseProps({
            chunkUpload,
            chunkTotal: 2,
            errorRows: [],
            confirming: false,
            onSkipChunk: () => {},
            onImportAnyway: () => {},
            onUndoSkip: () => {},
          })}
        />,
      );

      expect(findButton(container, "Skip this chunk")?.disabled).toBe(false);
      expect(findButton(container, "Import anyway")?.disabled).toBe(false);
      expect(findButton(container, "Undo skip")?.disabled).toBe(false);
    });
  });

  async function mount(element: ReactElement) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => root.render(element));
    return { container, root };
  }

  async function click(element: HTMLElement) {
    await act(async () => element.click());
  }
});

describe("PreviewStep — incremental error-row disclosure (Sol round-2 audit finding 4)", () => {
  const mountedRoots: Root[] = [];

  afterEach(async () => {
    for (const root of mountedRoots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
  });

  it("shows the first page, then reveals more on each click until every row is shown", async () => {
    const errorRows = Array.from({ length: 250 }, (_, i) => errorRow(i + 1));
    const { container } = await mount(<PreviewStep {...baseProps({ errorRows })} />);

    expect(rowErrorItems(container)).toHaveLength(MAX_SHOWN_ERROR_ROWS);
    expect(container.textContent).toContain("150 more row(s) with errors are not shown yet.");
    let showMore = findButton(container, "Show 100 more row(s) with errors");
    expect(showMore).toBeTruthy();

    await click(showMore!);
    expect(rowErrorItems(container)).toHaveLength(200);
    expect(container.textContent).toContain("50 more row(s) with errors are not shown yet.");
    showMore = findButton(container, "Show 50 more row(s) with errors");
    expect(showMore).toBeTruthy();

    await click(showMore!);
    expect(rowErrorItems(container)).toHaveLength(250);
    expect(container.textContent).not.toContain("more row(s) with errors are not shown yet.");
    expect(findButton(container, /Show \d+ more row\(s\) with errors/)).toBeFalsy();
  });

  async function mount(element: ReactElement) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => root.render(element));
    return { container, root };
  }

  async function click(element: HTMLElement) {
    await act(async () => element.click());
  }
});

// Round-5 audit finding 2: even with the server-side hardening (2a/2b),
// there's a narrow residual — a batch reverting AFTER toAlreadyExistsResult's
// fresh read but BEFORE the client acts on it. Resuming it is DATA-safe
// (apply only ever selects apply_status='not_applied' rows, untouched by a
// revert of an unapplied batch) but UI-confusing: eligibleNotApplied stays
// nonzero even though the batch is dead and apply_import_batch_chunk_v2
// no-ops on it. batch.batch.status is a fresh server read
// (GET /api/import/batches/[id]), so this is cheaply, reliably detectable
// client-side.
describe("BatchStep — a resumed batch that reads as reverted is surfaced honestly (round-5 audit finding 2)", () => {
  const mountedRoots: Root[] = [];

  afterEach(async () => {
    for (const root of mountedRoots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
  });

  function batchDetail(status: BatchDetail["batch"]["status"]): BatchDetail {
    return {
      batch: {
        id: "batch-1",
        filename: "cellar.csv",
        status,
        total_rows: 1,
        created_at: "2026-08-27T00:00:00.000Z",
        reverted_at: status === "reverted" ? "2026-08-27T00:00:01.000Z" : null,
      },
      rows: [
        {
          id: "row-1",
          row_number: 1,
          raw: { producer: "Domaine A", name: "Cuvee 1" },
          row_state: "valid",
          validation_errors: [],
          lwin_status: "matched",
          lwin_id: "lwin-1",
          cost_status: "present",
          resolution: "auto",
          manual_unit_cost: null,
          apply_status: "not_applied",
        },
      ],
    };
  }

  // Round-6 audit finding 6: the banner used to assert a specific cause
  // ("superseded by a duplicate import") that this component has no way to
  // actually know — a batch reaches status='reverted' for ANY reason a
  // revert can happen, including the operator's own deliberate revert.
  // Reworded to a neutral, always-true statement of fact.
  it("hides the Apply button and shows a neutral reverted-batch banner when the batch reads as reverted with rows still not_applied", async () => {
    const { container } = await mount(
      <BatchStep batch={batchDetail("reverted")} setBatch={() => {}} onDone={() => {}} />,
    );

    expect(findButton(container, /Apply \d+ row/)).toBeFalsy();
    expect(container.textContent).toContain("This import batch was reverted. Its rows were not imported");
    expect(container.textContent).not.toContain("superseded by a duplicate import");
  });

  it("shows the Apply button normally, and no banner, for a live (non-reverted) batch with the same row shape", async () => {
    const { container } = await mount(
      <BatchStep batch={batchDetail("created")} setBatch={() => {}} onDone={() => {}} />,
    );

    expect(findButton(container, /Apply \d+ row/)).toBeTruthy();
    expect(container.textContent).not.toContain("This import batch was reverted");
  });

  async function mount(element: ReactElement) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => root.render(element));
    return { container, root };
  }
});

// Round-10 audit (BLOCK 3(b)): the revert RPC (revert_import_batch, 0109)
// accepts any status <> 'reverted' — 'created', 'applying', AND
// 'completed' — but this button used to only render for 'completed',
// leaving a multiple_live_batches conflict naming a 'created' or 'applying'
// batch with no actual way to act on the server's own guidance.
describe("BatchStep — Revert is reachable for every live status, not only completed (round-10 audit BLOCK 3(b))", () => {
  const mountedRoots: Root[] = [];

  afterEach(async () => {
    for (const root of mountedRoots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
  });

  function batchDetail(status: BatchDetail["batch"]["status"]): BatchDetail {
    return {
      batch: {
        id: "batch-1",
        filename: "cellar.csv",
        status,
        total_rows: 1,
        created_at: "2026-08-27T00:00:00.000Z",
        reverted_at: status === "reverted" ? "2026-08-27T00:00:01.000Z" : null,
      },
      rows: [
        {
          id: "row-1",
          row_number: 1,
          raw: { producer: "Domaine A", name: "Cuvee 1" },
          row_state: "valid",
          validation_errors: [],
          lwin_status: "matched",
          lwin_id: "lwin-1",
          cost_status: "present",
          resolution: "auto",
          manual_unit_cost: null,
          apply_status: status === "created" ? "not_applied" : "applied",
        },
      ],
    };
  }

  it.each(["created", "applying", "completed"] as const)("shows Revert for a batch at status '%s'", async (status) => {
    const { container } = await mount(
      <BatchStep batch={batchDetail(status)} setBatch={() => {}} onDone={() => {}} />,
    );
    expect(findButton(container, /Revert this import/)).toBeTruthy();
  });

  it("hides Revert for an already-reverted batch", async () => {
    const { container } = await mount(
      <BatchStep batch={batchDetail("reverted")} setBatch={() => {}} onDone={() => {}} />,
    );
    expect(findButton(container, /Revert this import/)).toBeFalsy();
  });

  async function mount(element: ReactElement) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => root.render(element));
    return { container, root };
  }
});

// Round-8 audit finding 3: apply_import_batch_chunk_v2 (0108) already
// no-ops on a reverted batch, but the not-yet-applied rows it leaves alone
// keep eligibleNotApplied > 0 forever, so the old `done = body.done` (with
// `done` derived purely from that count) never flipped true — a batch
// reverted mid-apply left this loop retrying futilely up to its own
// 200-call guard. The apply route now also reports the batch's real
// status (batchStatus), and applyAll checks it directly.
describe("BatchStep — applyAll stops immediately on a reverted batchStatus (round-8 audit finding 3)", () => {
  const mountedRoots: Root[] = [];

  afterEach(async () => {
    for (const root of mountedRoots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  function detail(status: BatchDetail["batch"]["status"]): BatchDetail {
    return {
      batch: {
        id: "batch-1",
        filename: "cellar.csv",
        status,
        total_rows: 1,
        created_at: "2026-08-27T00:00:00.000Z",
        reverted_at: status === "reverted" ? "2026-08-27T00:00:01.000Z" : null,
      },
      rows: [
        {
          id: "row-1",
          row_number: 1,
          raw: { producer: "Domaine A", name: "Cuvee 1" },
          row_state: "valid",
          validation_errors: [],
          lwin_status: "matched",
          lwin_id: "lwin-1",
          cost_status: "present",
          resolution: "auto",
          manual_unit_cost: null,
          apply_status: "not_applied",
        },
      ],
    };
  }

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  it("makes exactly ONE apply call, stops the loop, and surfaces the reverted banner via the next refresh — never a futile retry loop", async () => {
    const applyCalls: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/apply") && init?.method === "POST") {
          applyCalls.push(url);
          return jsonResponse(200, {
            processed: [],
            status: "created",
            // The batch was reverted (e.g. by a concurrent reconciliation
            // cleanup) before this apply chunk ever ran — eligibleNotApplied
            // is still 1, exactly the case that used to loop forever.
            batchStatus: "reverted",
            counts: { total: 1, applied: 0, excluded: 0, pending: 0, eligibleNotApplied: 1 },
            done: true,
          });
        }
        if (url === "/api/import/batches/batch-1") {
          return jsonResponse(200, detail("reverted"));
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    function Harness() {
      const [batch, setBatch] = useState<BatchDetail>(detail("created"));
      return <BatchStep batch={batch} setBatch={setBatch} onDone={() => {}} />;
    }

    const { container } = await mount(<Harness />);
    const applyButton = findButton(container, /Apply \d+ row/);
    expect(applyButton).toBeTruthy();

    await click(applyButton!);

    // Exactly one apply call — the loop stopped the instant it saw
    // batchStatus "reverted", never retrying up to its own 200-call guard.
    expect(applyCalls).toHaveLength(1);
    // The refresh after the loop pulled the batch's real (reverted) state,
    // so the existing reverted-batch banner now renders and Apply is gone.
    expect(container.textContent).toContain("This import batch was reverted. Its rows were not imported");
    expect(findButton(container, /Apply \d+ row/)).toBeFalsy();
  });

  async function mount(element: ReactElement) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => root.render(element));
    return { container, root };
  }

  async function click(element: HTMLElement) {
    await act(async () => element.click());
  }
});

function rowItem(root: ParentNode, label: string): HTMLElement {
  const item = [...root.querySelectorAll<HTMLElement>("li")].find(
    (li) => li.querySelector("span")?.textContent?.trim() === label,
  );
  if (!item) throw new Error(`no row item found for label "${label}"`);
  return item;
}

function rowErrorItems(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("li")].filter((li) => li.querySelector("input") !== null);
}

function findButton(root: ParentNode, text: string | RegExp): HTMLButtonElement | undefined {
  return [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    typeof text === "string" ? b.textContent?.includes(text) : text.test(b.textContent ?? ""),
  );
}
