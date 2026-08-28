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
import { act, type ComponentProps, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PreviewStep, BatchStep, isRowInConfirmedChunk, MAX_SHOWN_ERROR_ROWS, type ErrorRowEntry, type BatchDetail } from "./import-client";
import { ZERO_SUMMARY, type ChunkUploadState, type ChunkedPlanState } from "./session-step";
import type { CanonicalHeader } from "@/domains/import/constants";

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

describe("PreviewStep — duplicate_chunk_content is recoverable, not a dead end (round-4 audit finding 2)", () => {
  const mountedRoots: Root[] = [];

  afterEach(async () => {
    for (const root of mountedRoots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
  });

  it("hides the Confirm/Retry button and renders honest guidance naming the other chunk, before anything is fixed", async () => {
    const chunkUpload: ChunkUploadState[] = [
      {
        index: 1,
        status: "failed",
        batchId: null,
        error:
          "Chunk 1's content is identical to chunk 2, already imported in this session — the database can't hold " +
          "two imports with identical content, so this can't be resolved by retrying unchanged. If this is a " +
          "genuine repeated segment that needs to import again, edit a row below so its fix actually DIFFERS from " +
          "chunk 2's own value for that row — re-entering the identical text won't change anything — then confirm " +
          "again. If it was an accidental duplicate, no action is needed, or skip this chunk below — chunk 2 " +
          "already imported these rows.",
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
    expect(container.textContent).toContain("actually DIFFERS");
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

  it("hides the Apply button and shows a superseded-import banner when the batch reads as reverted with rows still not_applied", async () => {
    const { container } = await mount(
      <BatchStep batch={batchDetail("reverted")} setBatch={() => {}} onDone={() => {}} />,
    );

    expect(findButton(container, /Apply \d+ row/)).toBeFalsy();
    expect(container.textContent).toContain("superseded by a duplicate import");
  });

  it("shows the Apply button normally, and no banner, for a live (non-reverted) batch with the same row shape", async () => {
    const { container } = await mount(
      <BatchStep batch={batchDetail("created")} setBatch={() => {}} onDone={() => {}} />,
    );

    expect(findButton(container, /Apply \d+ row/)).toBeTruthy();
    expect(container.textContent).not.toContain("superseded by a duplicate import");
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
