// The preview panel's client-side projection of what will actually import.
// This ran inline in PreviewStep's render body and could only be observed
// by rendering the component and reading its stat tiles.
import { describe, expect, it } from "vitest";
import { computePreviewCounts } from "./preview-counts";
import { ZERO_SUMMARY } from "./chunked-upload-types";
import type { PreviewSummary } from "./preview-service";
import type { ChunkUploadState } from "./chunked-upload-types";
import type { CanonicalHeader } from "./constants";
import type { ErrorRowEntry } from "./review-types";

function summary(overrides: Partial<PreviewSummary> = {}): PreviewSummary {
  return { ...ZERO_SUMMARY, ...overrides };
}

const BLANK_ROW: Record<CanonicalHeader, string> = {
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

/** One error row that fails only because it has no name/quantity. */
function errorRow(rowNumber: number): ErrorRowEntry {
  return {
    rowNumber,
    errors: [{ field: "name", message: "Name is required." }],
    rawText: { ...BLANK_ROW, producer: "Domaine A" },
  };
}

const FIXES = { name: "Cuvee One", quantity: "6" };

function chunkState(index: number, status: ChunkUploadState["status"]): ChunkUploadState {
  return { index, status, batchId: null, error: null, code: null };
}

describe("computePreviewCounts", () => {
  it("passes the server's own counts straight through when nothing was edited", () => {
    expect(
      computePreviewCounts({
        summary: summary({ validRows: 4, errorRows: 2 }),
        errorRows: [errorRow(1), errorRow(2)],
        rowOverrides: {},
        chunkUpload: null,
        chunkBreakdown: undefined,
      }),
    ).toEqual({
      fixedCount: 0,
      canConfirm: true,
      effectivePassingValidationRows: 4,
      effectiveErrorRows: 2,
      effectiveMissingProducerRows: 0,
    });
  });

  // SD-41: the number the operator acknowledges has to be the number
  // confirm will independently re-derive, and confirm re-derives WITH the
  // operator's inline fixes applied. A fix that leaves the producer blank
  // therefore adds to it — otherwise the checkbox would under-claim and the
  // server would reject the confirm as stale.
  it("counts a row fixed into validity WITHOUT a producer toward the blank-producer acknowledgement", () => {
    const blankProducerErrorRow: ErrorRowEntry = {
      rowNumber: 1,
      errors: [{ field: "name", message: "Name is required." }],
      rawText: { ...BLANK_ROW },
    };
    const counts = computePreviewCounts({
      summary: summary({ validRows: 4, errorRows: 1, missingProducerRows: 2 }),
      errorRows: [blankProducerErrorRow],
      rowOverrides: { 1: FIXES },
      chunkUpload: null,
      chunkBreakdown: undefined,
    });
    expect(counts.fixedCount).toBe(1);
    expect(counts.effectiveMissingProducerRows).toBe(3);
  });

  it("does not count a fix that supplies a producer", () => {
    const counts = computePreviewCounts({
      summary: summary({ validRows: 4, errorRows: 1, missingProducerRows: 2 }),
      errorRows: [errorRow(1)],
      rowOverrides: { 1: FIXES },
      chunkUpload: null,
      chunkBreakdown: undefined,
    });
    expect(counts.effectiveMissingProducerRows).toBe(2);
  });

  it("subtracts a skipped chunk's blank-producer rows — they are never sent", () => {
    const counts = computePreviewCounts({
      summary: summary({ validRows: 10, missingProducerRows: 6 }),
      errorRows: [],
      rowOverrides: {},
      chunkUpload: [chunkState(1, "confirmed"), chunkState(2, "skipped")],
      chunkBreakdown: [
        { index: 1, summary: summary({ validRows: 5, missingProducerRows: 2 }) },
        { index: 2, summary: summary({ validRows: 5, missingProducerRows: 4 }) },
      ],
    });
    expect(counts.effectiveMissingProducerRows).toBe(2);
  });

  it("moves a row the operator edited into validity from errors to passing", () => {
    const counts = computePreviewCounts({
      summary: summary({ validRows: 4, errorRows: 2 }),
      errorRows: [errorRow(1), errorRow(2)],
      rowOverrides: { 1: FIXES },
      chunkUpload: null,
      chunkBreakdown: undefined,
    });
    expect(counts.fixedCount).toBe(1);
    expect(counts.effectivePassingValidationRows).toBe(5);
    expect(counts.effectiveErrorRows).toBe(1);
  });

  it("lets a file with zero server-valid rows be confirmed once a row is fixed", () => {
    const base = { summary: summary({ validRows: 0, errorRows: 1 }), errorRows: [errorRow(1)], chunkUpload: null };
    expect(computePreviewCounts({ ...base, rowOverrides: {}, chunkBreakdown: undefined }).canConfirm).toBe(false);
    expect(computePreviewCounts({ ...base, rowOverrides: { 1: FIXES }, chunkBreakdown: undefined }).canConfirm).toBe(true);
  });

  it("does not credit a fix on a row belonging to a skipped chunk — it can never be sent", () => {
    const counts = computePreviewCounts({
      summary: summary({ validRows: 4, errorRows: 2 }),
      errorRows: [errorRow(1), errorRow(2)],
      rowOverrides: { 1: FIXES },
      isRowSkipped: (rowNumber) => rowNumber === 1,
      chunkUpload: null,
      chunkBreakdown: undefined,
    });
    expect(counts.fixedCount).toBe(0);
    expect(counts.effectivePassingValidationRows).toBe(4);
  });

  it("subtracts a skipped chunk's own valid rows from the passing count", () => {
    const counts = computePreviewCounts({
      summary: summary({ validRows: 10, errorRows: 0 }),
      errorRows: [],
      rowOverrides: {},
      chunkUpload: [chunkState(1, "confirmed"), chunkState(2, "skipped")],
      chunkBreakdown: [
        { index: 1, summary: summary({ validRows: 6 }) },
        { index: 2, summary: summary({ validRows: 4 }) },
      ],
    });
    expect(counts.effectivePassingValidationRows).toBe(6);
  });

  it("restores the count as soon as a chunk leaves the skipped state", () => {
    const chunkBreakdown = [
      { index: 1, summary: summary({ validRows: 6 }) },
      { index: 2, summary: summary({ validRows: 4 }) },
    ];
    const counts = computePreviewCounts({
      summary: summary({ validRows: 10 }),
      errorRows: [],
      rowOverrides: {},
      chunkUpload: [chunkState(1, "confirmed"), chunkState(2, "failed")],
      chunkBreakdown,
    });
    expect(counts.effectivePassingValidationRows).toBe(10);
  });
});
