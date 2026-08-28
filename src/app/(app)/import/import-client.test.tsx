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
  buildApprovedLwinRows,
  skipChunk,
  undoSkipChunk,
  MAX_SHOWN_ERROR_ROWS,
  type ErrorRowEntry,
  type BatchDetail,
  type MatchedLwinRowEntry,
} from "./import-client";
import { ZERO_SUMMARY, type ChunkUploadState, type ChunkedPlanState } from "./session-step";
import {
  CLIENT_CHUNK_TARGET_ROWS,
  LWIN_MATCH_UX_CEILING_SECONDS,
  MAX_ROWS,
  type CanonicalHeader,
} from "@/domains/import/constants";

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

// Round-27 audit: removes the in-preview conflict-recovery panel, which
// failed five straight audits (rounds 18, 20, 22, 24, 26) for the same
// reason each time — two or more sources of guidance on screen that
// disagreed with each other and with the buttons (BLOCK 1), and a
// client-invented duplicate_race_retry_exhausted terminal state built from
// a server response the service defines as retryable, asserting a live
// rival batch that might not exist (BLOCK 2). See docs/runbooks/
// csv-import.md for the full history. The panel, its standing instruction,
// the per-candidate revert affordance, and the escalation are all deleted.
// What remains: the server's own message is the ONLY guidance shown for a
// conflict, and Confirm/Retry stays available for both multiple_live_batches
// and duplicate_race_retry — the server re-checks on every attempt, so a
// retry that changes nothing simply re-raises the same conflict.
describe("PreviewStep — a multiple_live_batches conflict shows the server's message and leaves Confirm/Retry available (round-27 audit)", () => {
  const mountedRoots: Root[] = [];

  afterEach(async () => {
    for (const root of mountedRoots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
  });

  it("chunked path: renders the server's message verbatim, keeps Retry upload available, and shows no separate conflict panel or standing instruction", async () => {
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
    expect(buttons.some((b) => b.textContent?.includes("Retry upload"))).toBe(true);
    // The server's message is the only guidance rendered — no separate
    // panel listing candidates, and no competing standing instruction.
    expect(container.textContent).toContain(serverMessage);
    expect(container.textContent).not.toContain("Conflicting live imports");
  });

  it("plain (non-chunked) path: keeps Confirm import available alongside the server's message", async () => {
    const serverMessage = "This file has 2 live import batches for the same underlying content.";
    const { container } = await mount(<PreviewStep {...baseProps({ chunkUpload: null, error: serverMessage })} />);

    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.some((b) => b.textContent?.includes("Confirm import"))).toBe(true);
    expect(container.textContent).toContain(serverMessage);
    expect(container.textContent).not.toContain("Conflicting live imports");
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

// Round-27 audit (BLOCK 2): duplicate_race_retry is retryable BY DESIGN —
// batch-service.ts's own reconcileLiveBatchesForFile can emit it with ZERO
// live batches (a self-revert race that failed to fully withdraw). The
// client used to count consecutive occurrences and, after a fixed limit,
// synthesize a distinct terminal duplicate_race_retry_exhausted code that
// hid Confirm/Retry and asserted a live conflicting batch and a Recent-
// imports recovery location that might not exist. That escalation is
// deleted: this code never blocks the button, no matter how many times it
// recurs, in either the chunked or the plain path.
describe("PreviewStep — duplicate_race_retry stays retryable no matter how many times it occurs (round-27 audit)", () => {
  const mountedRoots: Root[] = [];

  afterEach(async () => {
    for (const root of mountedRoots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
  });

  it("chunked path: Retry upload stays available for a chunk failing with duplicate_race_retry", async () => {
    const serverMessage = "Another import attempt for this file is being cleaned up — please retry the upload.";
    const chunkUpload: ChunkUploadState[] = [
      { index: 1, status: "failed", batchId: null, error: serverMessage, code: "duplicate_race_retry" },
    ];

    const { container } = await mount(
      <PreviewStep {...baseProps({ chunkUpload, chunkTotal: 1, error: serverMessage })} />,
    );

    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.some((b) => b.textContent?.includes("Retry upload"))).toBe(true);
    expect(container.textContent).toContain(serverMessage);
  });

  it("plain path: Confirm import stays available for a duplicate_race_retry failure", async () => {
    const serverMessage = "Another import attempt for this file is being cleaned up — please retry the upload.";
    const { container } = await mount(<PreviewStep {...baseProps({ chunkUpload: null, error: serverMessage })} />);

    expect(findButton(container, "Confirm import")).toBeTruthy();
    expect(container.textContent).toContain(serverMessage);
  });

  // There is no longer any client-side notion of "duplicate_race_retry_exhausted"
  // to escalate to — but if a caller somehow supplied that code (a stale
  // server, a hand-built fixture), PreviewStep must not treat it as special
  // either: only chunk_content_mismatch and duplicate_chunk_content remain
  // terminal in this panel.
  it("does not block Confirm/Retry even for the old, now-meaningless duplicate_race_retry_exhausted code string", async () => {
    const chunkUpload: ChunkUploadState[] = [
      { index: 1, status: "failed", batchId: null, error: "stale code", code: "duplicate_race_retry_exhausted" },
    ];
    const { container } = await mount(<PreviewStep {...baseProps({ chunkUpload, chunkTotal: 1 })} />);
    expect(findButton(container, "Retry upload")).toBeTruthy();
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

// Round-27 audit: with the in-preview conflict panel gone, Recent imports
// is the only place left to revert a conflicting batch. It used to render
// only the ten newest, so a conflicting batch old enough to have aged out
// was unreachable — GET /api/import/batches has never had a server-side
// cap (route.ts's getBatches), and BatchStep's own Revert already accepts
// any non-reverted status (round-13 audit), so raising the client-side
// display limit is the smallest change that makes every non-reverted batch
// findable and revertable again.
describe("ImportClient — Recent imports lists and can revert a batch that is not among the ten newest (round-27 audit)", () => {
  const mountedRoots: Root[] = [];

  afterEach(async () => {
    for (const root of mountedRoots.splice(0)) {
      await act(async () => root.unmount());
    }
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("renders an 11th batch (older than the ten-newest window) and reverts it", async () => {
    // Newest-first, exactly as the real GET /api/import/batches route
    // returns them (order("created_at", { ascending: false })). "batch-10"
    // is the OLDEST — the one an old ten-item cap would have dropped.
    const batches = Array.from({ length: 11 }, (_, i) => ({
      id: `batch-${i}`,
      filename: `cellar-${i}.csv`,
      status: "completed" as const,
      total_rows: 3,
      created_at: new Date(2026, 0, 11 - i).toISOString(),
      reverted_at: null,
    }));
    const oldest = batches[batches.length - 1];

    let revertCalled = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/import/batches" && method === "GET") {
        return new Response(JSON.stringify({ batches }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === `/api/import/batches/${oldest.id}` && method === "GET") {
        return new Response(JSON.stringify({ batch: oldest, rows: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === `/api/import/batches/${oldest.id}/revert` && method === "POST") {
        revertCalled = true;
        return new Response(
          JSON.stringify({
            revertedCount: 3,
            orphanWinesDeleted: 0,
            lwinStampsCleared: 0,
            cleanupTruncated: false,
            orphanCleanupSkipped: false,
            cleanupFailures: 0,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });

    const { container } = await mount(<ImportClient />);
    // loadRecent's effect resolves asynchronously.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Every batch renders, including the oldest — not just the ten newest.
    expect(container.textContent).toContain(oldest.filename);

    const openButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      b.textContent?.includes(oldest.filename),
    );
    expect(openButton).toBeTruthy();
    await act(async () => openButton!.click());

    const revertButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === "Revert this import",
    );
    expect(revertButton).toBeTruthy();
    await act(async () => revertButton!.click());
    const confirmButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === "Revert import",
    );
    expect(confirmButton).toBeTruthy();
    await act(async () => confirmButton!.click());

    expect(revertCalled).toBe(true);
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

  // WARN 5 (Sol audit round 3): a rejection or an approved-match change
  // also namespaces content_sha256 (the v2/v3 tiers — see
  // confirmImportBatch's own digest-construction comment), exactly like an
  // override does — but the gate used to compare ONLY the override slice,
  // so rejecting (or un-rejecting) a match after a duplicate_chunk_content
  // collision left Confirm/Retry hidden even though the next attempt would
  // genuinely hash differently. These mirror the override-differs/
  // override-unchanged pair above, for the two new slices.
  it("keeps Retry HIDDEN when the current rejected-match set is UNCHANGED from what was sent and failed", async () => {
    const chunkUpload: ChunkUploadState[] = [
      {
        index: 1,
        status: "failed",
        batchId: null,
        error: "Chunk 1's content is identical to chunk 2.",
        code: "duplicate_chunk_content",
        sentRejectedLwinRowsSnapshot: [1],
      },
    ];

    const { container } = await mount(
      <PreviewStep
        {...baseProps({
          chunkUpload,
          chunkTotal: 2,
          chunkBreakdown: [{ index: 1, startRow: 1, endRow: 1, summary: ZERO_SUMMARY }],
          error: chunkUpload[0].error,
          // Same rejected set the failed attempt already sent.
          rejectedLwinRows: new Set([1]),
        })}
      />,
    );

    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.some((b) => b.textContent?.includes("Retry upload"))).toBe(false);
  });

  it("shows Retry once a match is rejected that WASN'T rejected in the failed attempt", async () => {
    const chunkUpload: ChunkUploadState[] = [
      {
        index: 1,
        status: "failed",
        batchId: null,
        error: "Chunk 1's content is identical to chunk 2.",
        code: "duplicate_chunk_content",
        sentRejectedLwinRowsSnapshot: [],
      },
    ];

    const { container } = await mount(
      <PreviewStep
        {...baseProps({
          chunkUpload,
          chunkTotal: 2,
          chunkBreakdown: [{ index: 1, startRow: 1, endRow: 1, summary: ZERO_SUMMARY }],
          error: chunkUpload[0].error,
          // A genuinely new rejection, not present in the sent snapshot.
          rejectedLwinRows: new Set([1]),
        })}
      />,
    );

    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.some((b) => b.textContent?.includes("Retry upload"))).toBe(true);
  });

  it("keeps Retry HIDDEN when the current linking-matched set is UNCHANGED from the approved-match snapshot sent and failed", async () => {
    const chunkUpload: ChunkUploadState[] = [
      {
        index: 1,
        status: "failed",
        batchId: null,
        error: "Chunk 1's content is identical to chunk 2.",
        code: "duplicate_chunk_content",
        sentApprovedLwinRowsSnapshot: { 1: "LWIN001" },
      },
    ];

    const { container } = await mount(
      <PreviewStep
        {...baseProps({
          chunkUpload,
          chunkTotal: 2,
          chunkBreakdown: [{ index: 1, startRow: 1, endRow: 1, summary: ZERO_SUMMARY }],
          error: chunkUpload[0].error,
          matchedRows: [{ rowNumber: 1, lwinId: "LWIN001", lwinDisplayName: "Domaine A", lwinScore: 0.9 }],
        })}
      />,
    );

    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.some((b) => b.textContent?.includes("Retry upload"))).toBe(false);
  });

  it("shows Retry once the linking-matched lwin_id DIFFERS from the approved-match snapshot that was sent and failed", async () => {
    const chunkUpload: ChunkUploadState[] = [
      {
        index: 1,
        status: "failed",
        batchId: null,
        error: "Chunk 1's content is identical to chunk 2.",
        code: "duplicate_chunk_content",
        sentApprovedLwinRowsSnapshot: { 1: "LWIN001" },
      },
    ];

    const { container } = await mount(
      <PreviewStep
        {...baseProps({
          chunkUpload,
          chunkTotal: 2,
          chunkBreakdown: [{ index: 1, startRow: 1, endRow: 1, summary: ZERO_SUMMARY }],
          error: chunkUpload[0].error,
          // A genuinely different re-match than the one that was sent.
          matchedRows: [{ rowNumber: 1, lwinId: "LWIN002", lwinDisplayName: "Domaine B", lwinScore: 0.9 }],
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

// Item 2 (per-row LWIN match visibility/rejection): a PR #133 audit (variant
// LWIN matching lifted the match rate 29.6% -> 77.0%) BLOCKed on the UI
// showing only an aggregate "LWIN matched" count — a wrong match applied
// silently, and the higher the match rate, the more wrong matches. This
// pins that each matched row's own catalog name + score render, and that
// the reject toggle round-trips through onToggleLwinReject.
describe("PreviewStep — matched-row visibility and rejection (item 2)", () => {
  const mountedRoots: Root[] = [];

  afterEach(async () => {
    for (const root of mountedRoots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
  });

  it("renders each matched row's catalog display name and score", async () => {
    const { container } = await mount(
      <PreviewStep
        {...baseProps({
          matchedRows: [
            { rowNumber: 1, lwinId: "LWIN001", lwinDisplayName: "Domaine A Cuvee One 2020", lwinScore: 0.92 },
          ],
        })}
      />,
    );

    expect(container.textContent).toContain("Matched wines (1)");
    const item = rowItem(container, "Row 1");
    expect(item.textContent).toContain("Domaine A Cuvee One 2020");
    expect(item.textContent).toContain("0.92");
    expect(findButton(item, "Reject match")).toBeTruthy();
  });

  // BLOCK 2 (round-13 fix) — this used to render an apply-eligible,
  // no-identity match under "Matched wines" with a "Catalog entry (name
  // unavailable)" placeholder AND a live "Reject match" control, while
  // the row was STILL auto-included in approvedLwinRows regardless of
  // what the operator did with that control — a wrong match could apply
  // with no identity ever shown. Now it's treated as not-shown entirely:
  // it renders under NEITHER band (not "Matched wines" — nothing to
  // verify; not "Below match threshold" — its score genuinely clears that
  // bar, so that band's "will import with no catalog link" copy would be
  // a lie), and buildApprovedLwinRows' own fail-closed test (below) pins
  // that it's never auto-approved either.
  it("treats an apply-eligible match with no display identity as not-shown — never under Matched wines, never under Below match threshold", async () => {
    const { container } = await mount(
      <PreviewStep
        {...baseProps({ matchedRows: [{ rowNumber: 1, lwinId: "LWIN001", lwinDisplayName: null, lwinScore: 0.65 }] })}
      />,
    );

    expect(container.textContent).not.toContain("Matched wines");
    expect(container.textContent).not.toContain("Below match threshold");
    expect(container.textContent).not.toContain("Catalog entry (name unavailable)");
  });

  it("calls onToggleLwinReject with the row number when Reject match is clicked", async () => {
    const toggled: number[] = [];
    const { container } = await mount(
      <PreviewStep
        {...baseProps({
          matchedRows: [{ rowNumber: 3, lwinId: "LWIN003", lwinDisplayName: "Wine 3", lwinScore: 0.7 }],
          onToggleLwinReject: (rowNumber) => toggled.push(rowNumber),
        })}
      />,
    );

    await click(findButton(container, "Reject match")!);
    expect(toggled).toEqual([3]);
  });

  it("shows the rejected state and an Undo reject control once a row is in rejectedLwinRows", async () => {
    const { container } = await mount(
      <PreviewStep
        {...baseProps({
          matchedRows: [{ rowNumber: 1, lwinId: "LWIN001", lwinDisplayName: "Domaine A", lwinScore: 0.9 }],
          rejectedLwinRows: new Set([1]),
        })}
      />,
    );

    const item = rowItem(container, "Row 1");
    expect(item.textContent).toContain("Match rejected");
    expect(item.textContent).not.toContain("Domaine A");
    expect(findButton(item, "Undo reject")).toBeTruthy();
    expect(findButton(item, "Reject match")).toBeFalsy();
  });

  it("renders nothing when matchedRows is omitted — every pre-existing caller keeps working unchanged", async () => {
    const { container } = await mount(<PreviewStep {...baseProps()} />);
    expect(container.textContent).not.toContain("Matched wines");
  });

  // BLOCK 3 (Sol audit round 3, finding 3): preview classifies a match at
  // score >= 0.3 (LWIN_MATCH_THRESHOLD), but apply only stamps at score >=
  // 0.6 (LWIN_APPLY_MIN_SCORE) — a sub-threshold row was previously listed
  // under "Matched wines" with a live reject control even though rejecting
  // it (or not) could never change what apply actually writes. These pin
  // the fix: a sub-threshold candidate renders in its own honestly-labeled
  // band, with no reject control, and the "Matched wines" count/list only
  // ever includes rows that will actually link.
  it("separates a below-apply-threshold candidate into its own band, with no reject control", async () => {
    const { container } = await mount(
      <PreviewStep
        {...baseProps({
          matchedRows: [
            { rowNumber: 1, lwinId: "LWIN001", lwinDisplayName: "Domaine A", lwinScore: 0.9 },
            { rowNumber: 2, lwinId: "LWIN002", lwinDisplayName: "Domaine B", lwinScore: 0.45 },
          ],
        })}
      />,
    );

    // "Matched wines" only counts/lists the linking row.
    expect(container.textContent).toContain("Matched wines (1)");
    expect(rowItem(container, "Row 1").textContent).toContain("Domaine A");
    expect(findButton(rowItem(container, "Row 1"), "Reject match")).toBeTruthy();

    // The sub-threshold row gets its own band, its own honest copy, and no
    // reject control at all.
    expect(container.textContent).toContain("Below match threshold (1)");
    const belowThresholdItem = rowItem(container, "Row 2");
    expect(belowThresholdItem.textContent).toContain("Domaine B");
    expect(belowThresholdItem.textContent).toContain("will import with no catalog link");
    expect(findButton(belowThresholdItem, "Reject match")).toBeFalsy();
    expect(findButton(belowThresholdItem, /reject/i)).toBeFalsy();
  });

  it("renders no 'Matched wines' section when every candidate is below the apply threshold", async () => {
    const { container } = await mount(
      <PreviewStep
        {...baseProps({
          matchedRows: [{ rowNumber: 1, lwinId: "LWIN001", lwinDisplayName: "Domaine A", lwinScore: 0.4 }],
        })}
      />,
    );

    expect(container.textContent).not.toContain("Matched wines (");
    expect(container.textContent).toContain("Below match threshold (1)");
  });

  it("disables the reject toggle for a row whose chunk is already confirmed, with the same explanatory copy RowFixItem uses (Sol round-2 audit finding 1's reasoning)", async () => {
    const { container } = await mount(
      <PreviewStep
        {...baseProps({
          matchedRows: [
            { rowNumber: 1, lwinId: "LWIN001", lwinDisplayName: "Domaine A", lwinScore: 0.9 },
            { rowNumber: 3, lwinId: "LWIN003", lwinDisplayName: "Domaine C", lwinScore: 0.8 },
          ],
          isRowLocked: (rowNumber) => rowNumber === 1,
        })}
      />,
    );

    const lockedItem = rowItem(container, "Row 1");
    expect(findButton(lockedItem, "Reject match")!.disabled).toBe(true);
    expect(lockedItem.textContent).toContain("Row already imported with this chunk — revert the import to change it.");

    const unlockedItem = rowItem(container, "Row 3");
    expect(findButton(unlockedItem, "Reject match")!.disabled).toBe(false);
  });

  it("disables the reject toggle while a confirm attempt is in flight (same freeze as RowFixItem's own inputs)", async () => {
    const { container } = await mount(
      <PreviewStep
        {...baseProps({
          matchedRows: [{ rowNumber: 1, lwinId: "LWIN001", lwinDisplayName: "Domaine A", lwinScore: 0.9 }],
          confirming: true,
        })}
      />,
    );

    expect(findButton(container, "Reject match")!.disabled).toBe(true);
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

function matchedRow(overrides: Partial<MatchedLwinRowEntry> = {}): MatchedLwinRowEntry {
  return { rowNumber: 1, lwinId: "LWIN001", lwinDisplayName: "Domaine A", lwinScore: 0.9, ...overrides };
}

// BLOCK 2 (round-13 fix) — buildApprovedLwinRows is the actual gate that
// decides which matches get auto-stamped at confirm (via
// applyLwinApprovalVeto, batch-service.ts): a row absent from its output
// is treated exactly like an explicit rejection server-side. These pin the
// fail-closed residual this round's fix adds: an apply-eligible match with
// no display identity must never be approved, even though its score alone
// would otherwise qualify it.
describe("buildApprovedLwinRows (BLOCK 2, round-13 fix)", () => {
  it("approves an apply-eligible row with a display identity", () => {
    expect(buildApprovedLwinRows([matchedRow({ rowNumber: 1, lwinScore: 0.9, lwinDisplayName: "Domaine A" })])).toEqual({
      1: "LWIN001",
    });
  });

  it("fails CLOSED on an apply-eligible row with no display identity — never approved, even though its score alone qualifies", () => {
    expect(
      buildApprovedLwinRows([
        matchedRow({ rowNumber: 1, lwinId: "LWIN001", lwinScore: 0.65, lwinDisplayName: null }),
      ]),
    ).toEqual({});
  });

  it("excludes a below-apply-threshold row regardless of display identity", () => {
    expect(
      buildApprovedLwinRows([matchedRow({ rowNumber: 1, lwinScore: 0.45, lwinDisplayName: "Domaine A" })]),
    ).toEqual({});
  });

  it("mixes eligible, no-identity, and below-threshold rows correctly in one payload", () => {
    expect(
      buildApprovedLwinRows([
        matchedRow({ rowNumber: 1, lwinId: "LWIN001", lwinScore: 0.9, lwinDisplayName: "Domaine A" }),
        matchedRow({ rowNumber: 2, lwinId: "LWIN002", lwinScore: 0.65, lwinDisplayName: null }),
        matchedRow({ rowNumber: 3, lwinId: "LWIN003", lwinScore: 0.4, lwinDisplayName: "Domaine C" }),
      ]),
    ).toEqual({ 1: "LWIN001" });
  });
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
          lwin_score: 0.9,
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
          lwin_score: 0.9,
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
          lwin_score: 0.9,
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

// The round-11 fix (d6813cb, "show the expected matching wait before either
// phase, on every path") is the ENTIRE justification for raising
// LWIN_MATCH_UX_CEILING_SECONDS from 60s to 120s (see that constant's own
// comment): the longer wait is only defensible because the operator sees an
// honest estimate before committing to it, on both the single-file and
// chunked paths, before Preview AND before Confirm. Nothing exercised
// countPreviewUnits or this copy before this describe block — a regression
// silently dropping the disclosure would have shipped green.
describe("wait-estimate disclosure (justifies LWIN_MATCH_UX_CEILING_SECONDS, round-11 fix d6813cb)", () => {
  const mountedRoots: Root[] = [];

  afterEach(async () => {
    for (const root of mountedRoots.splice(0)) {
      await act(async () => root.unmount());
    }
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  // Reproduces import-client.tsx's own (unexported) formatRoughDuration
  // rule — < 90s renders as "Ns", otherwise ceil(seconds / 60) minutes —
  // against LWIN_MATCH_UX_CEILING_SECONDS itself, so the expected string is
  // DERIVED from the constant rather than a hardcoded "2 minutes": a future
  // change to the ceiling moves this expectation with it, and a component
  // that hardcodes its own number instead of deriving it from the real
  // unit count still gets caught.
  function expectedDuration(units: number): string {
    const seconds = units * LWIN_MATCH_UX_CEILING_SECONDS;
    if (seconds < 90) return `${seconds}s`;
    const minutes = Math.ceil(seconds / 60);
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  function csvFile(name: string, dataRows: number): File {
    const lines = ["name,quantity"];
    for (let i = 1; i <= dataRows; i++) lines.push(`Wine ${i},1`);
    return new File([lines.join("\n") + "\n"], name, { type: "text/csv" });
  }

  async function mountImportClient(): Promise<{ container: HTMLElement }> {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ batches: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => root.render(<ImportClient />));
    return { container };
  }

  // countPreviewUnits reads file.arrayBuffer() (a microtask) before its
  // .then() sets previewUnits — flush enough ticks for that chain to settle
  // before asserting on the render it produces.
  async function selectFile(container: HTMLElement, file: File) {
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    Object.defineProperty(input, "files", { value: transfer.files, configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
  }

  async function mountPreviewStep(overrides: Partial<PreviewStepProps>): Promise<{ container: HTMLElement }> {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => root.render(<PreviewStep {...baseProps(overrides)} />));
    return { container };
  }

  function previewButtonOf(container: HTMLElement): HTMLButtonElement {
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      b.textContent?.includes("Preview import"),
    );
    if (!button) throw new Error("no Preview import button found");
    return button;
  }

  it("single-file path: shows the estimate in UploadStep before Preview is clicked", async () => {
    const { container } = await mountImportClient();
    await selectFile(container, csvFile("small.csv", 10));

    expect(container.textContent).toContain("Previewing this file is estimated to take");
    expect(container.textContent).toContain(expectedDuration(1));

    // Not yet clicked: the button still reads "Preview import", never
    // "Reading file…" (previewing=true) — proves the estimate showed up
    // BEFORE the operator committed to the wait. And now that the
    // estimate has settled, the button is enabled (BLOCK 1, round-13 fix).
    const previewButton = previewButtonOf(container);
    expect(previewButton.textContent).toContain("Preview import");
    expect(previewButton.disabled).toBe(false);
  });

  // WARN 3 (round-13 fix) — this used to only ever exercise MAX_ROWS + 1
  // rows, which always yields exactly 2 chunks (ceil(5001 / 4000)) — a
  // production hardcoded to `estimateChunkedPhaseWaitSeconds(2)` would have
  // passed this unchanged. Parametrized over two DISTINCT chunk counts (2
  // and 3) so a hardcoded chunk count fails.
  it.each([
    { dataRows: MAX_ROWS + 1 },
    { dataRows: 2 * CLIENT_CHUNK_TARGET_ROWS + 1 },
  ])(
    "chunked path: shows the estimate AND the chunk count in UploadStep before Preview is clicked ($dataRows rows)",
    async ({ dataRows }) => {
      const { container } = await mountImportClient();
      const expectedChunks = Math.ceil(dataRows / CLIENT_CHUNK_TARGET_ROWS);
      await selectFile(container, csvFile("big.csv", dataRows));

      expect(container.textContent).toContain(`This file needs ${expectedChunks} chunks`);
      expect(container.textContent).toContain(expectedDuration(expectedChunks));

      const previewButton = previewButtonOf(container);
      expect(previewButton.disabled).toBe(false);
    },
  );

  it("plain path: shows the estimate again in PreviewStep before Confirm is clicked", async () => {
    const { container } = await mountPreviewStep({});

    expect(container.textContent).toContain("Confirming it is estimated to take up to");
    expect(container.textContent).toContain(expectedDuration(1));

    const confirmButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      b.textContent?.includes("Confirm import"),
    );
    expect(confirmButton).toBeTruthy();
  });

  // WARN 3 (round-13 fix) — the confirm-side fixture used to only ever use
  // chunkTotal: 3. Parametrized over two DISTINCT chunk totals (3 and 5)
  // so a hardcoded `estimateChunkedPhaseWaitSeconds(3)` (or a hardcoded "3
  // chunks" copy check) fails.
  it.each([{ chunkTotal: 3 }, { chunkTotal: 5 }])(
    "chunked path: shows the estimate again in PreviewStep before Confirm is clicked, naming the chunk count (chunkTotal=$chunkTotal)",
    async ({ chunkTotal }) => {
      const { container } = await mountPreviewStep({ chunkTotal });

      expect(container.textContent).toContain(`split into ${chunkTotal} chunks`);
      expect(container.textContent).toContain("Confirming it is estimated to take up to");
      expect(container.textContent).toContain(expectedDuration(chunkTotal));
    },
  );

  // Round-29 audit's old copy ("up to about Xs in the worst case") stated
  // more certainty than the numbers behind it have — corrected in d6813cb.
  // Asserts the honest replacement, not just its presence: an explicit
  // "not a guaranteed cap" disclaimer, and none of the old bound-implying
  // phrasing ("worst case", "maximum").
  //
  // WARN 3 (round-13 fix) — this used to inspect ONLY PreviewStep's own
  // rendering. UploadStep renders the identical estimate copy
  // (describeWaitEstimate) through a completely separate code path
  // (UploadStep's own wait-estimate paragraph, gated on previewUnits/
  // previewUnitsStatus rather than PreviewStep's props) — a regression
  // there (e.g. a stray "worst case" reintroduced only in UploadStep's own
  // JSX) would have shipped green. Now runs the same assertions against
  // both UploadStep renderings (single-file and chunked) too.
  it("the wording is honest — an estimate, never a guaranteed/worst-case bound", async () => {
    const single = await mountPreviewStep({});
    const chunked = await mountPreviewStep({ chunkTotal: 2 });
    const uploadSingle = await mountImportClient();
    await selectFile(uploadSingle.container, csvFile("small.csv", 10));
    const uploadChunked = await mountImportClient();
    await selectFile(uploadChunked.container, csvFile("big.csv", MAX_ROWS + 1));

    for (const { container } of [single, chunked, uploadSingle, uploadChunked]) {
      const text = (container.textContent ?? "").toLowerCase();
      expect(text).toContain("not a guaranteed cap");
      expect(text).toContain("estimate");
      expect(text).not.toContain("worst case");
      expect(text).not.toMatch(/\bmaximum\b/);
    }
  });

  // BLOCK 1 (round-13 fix) — countPreviewUnits resolves asynchronously
  // (file.arrayBuffer(), then decode/split), so previewUnits/
  // previewUnitsStatus for the just-selected file is NOT available the
  // instant `file` changes. Round-12's tests all waited six microtasks
  // before ever inspecting the button, so neither race below could have
  // been caught: an operator clicking Preview in that window used to reach
  // handlePreview with no disclosure ever having been shown.
  //
  // Both races below hold a file's own `arrayBuffer()` read open with a
  // manually-controlled promise (rather than relying on how many
  // unrelated microtasks `act()` happens to drain on its own) — this makes
  // the "still pending" window deterministic to observe and settle,
  // instead of racing the test against React's own internal scheduling.
  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  it("clicking immediately after selection can't race ahead of the estimate — Preview is disabled until it settles", async () => {
    const { container } = await mountImportClient();
    const file = csvFile("small.csv", 10);
    const realBytes = await file.arrayBuffer();
    const gate = deferred<ArrayBuffer>();
    vi.spyOn(file, "arrayBuffer").mockReturnValue(gate.promise);

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    Object.defineProperty(input, "files", { value: transfer.files, configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // countPreviewUnits' own file.arrayBuffer() read is deliberately held
    // open — Preview stays disabled and no estimate is shown for however
    // long that read takes, proving the gate isn't a fixed number of
    // microtask ticks that happened to be enough in round-12's own tests.
    const previewButton = previewButtonOf(container);
    expect(previewButton.disabled).toBe(true);
    expect(container.textContent).not.toContain("Previewing this file is estimated to take");

    await act(async () => {
      gate.resolve(realBytes);
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
    expect(previewButton.disabled).toBe(false);
    expect(container.textContent).toContain(expectedDuration(1));
  });

  it("switching from a small file to a large one clears the stale estimate immediately and disables Preview until the NEW file settles", async () => {
    const { container } = await mountImportClient();
    await selectFile(container, csvFile("small.csv", 10));
    expect(container.textContent).toContain(expectedDuration(1));
    const previewButton = previewButtonOf(container);
    expect(previewButton.disabled).toBe(false);

    // Swap in a much bigger file whose own arrayBuffer() read is held
    // open — its estimate deliberately never resolves during this test.
    const dataRows = 2 * CLIENT_CHUNK_TARGET_ROWS + 1;
    const expectedChunks = Math.ceil(dataRows / CLIENT_CHUNK_TARGET_ROWS);
    const bigFile = csvFile("big.csv", dataRows);
    const bigFileRealBytes = await bigFile.arrayBuffer();
    const gate = deferred<ArrayBuffer>();
    vi.spyOn(bigFile, "arrayBuffer").mockReturnValue(gate.promise);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const transfer = new DataTransfer();
    transfer.items.add(bigFile);
    Object.defineProperty(input, "files", { value: transfer.files, configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // The small file's estimate is gone immediately — an operator reading
    // the screen right now never sees a number that belongs to the file
    // they just moved away from — and Preview is disabled again for as
    // long as the NEW file's own read is still open.
    expect(container.textContent).not.toContain(expectedDuration(1));
    expect(previewButton.disabled).toBe(true);

    await act(async () => {
      gate.resolve(bigFileRealBytes);
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
    expect(container.textContent).toContain(`This file needs ${expectedChunks} chunks`);
    expect(container.textContent).toContain(expectedDuration(expectedChunks));
    expect(previewButton.disabled).toBe(false);
  });
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
