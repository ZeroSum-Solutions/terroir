// The "did this genuinely change" retry gate for a chunk stuck on
// duplicate_chunk_content. This ran inline in PreviewStep's render body and
// could previously only be observed by asserting on the presence or absence
// of a rendered "Retry upload" button.
import { describe, expect, it } from "vitest";
import {
  approvedSliceEqual,
  computeUnresolvedDuplicateChunkContentIndexes,
  numberSliceEqual,
  overridesSliceEqual,
} from "./duplicate-chunk-retry";
import { LWIN_APPLY_MIN_SCORE } from "./constants";
import type { ChunkUploadState } from "./chunked-upload-types";
import type { MatchedLwinRowEntry } from "./review-types";

describe("overridesSliceEqual", () => {
  it("ignores key order and undefined field values", () => {
    expect(
      overridesSliceEqual({ 2: { name: "B" }, 1: { quantity: "6" } }, { 1: { quantity: "6" }, 2: { name: "B" } }),
    ).toBe(true);
    expect(overridesSliceEqual({ 1: { quantity: "6", name: undefined } }, { 1: { quantity: "6" } })).toBe(true);
  });

  it("treats a row whose every field was cleared as absent", () => {
    expect(overridesSliceEqual({ 1: {} }, {})).toBe(true);
  });

  it("sees a changed value as different", () => {
    expect(overridesSliceEqual({ 1: { quantity: "6" } }, { 1: { quantity: "7" } })).toBe(false);
  });
});

describe("numberSliceEqual", () => {
  it("ignores order and duplicates", () => {
    expect(numberSliceEqual([3, 1, 1], [1, 3])).toBe(true);
  });

  it("sees an added row as different", () => {
    expect(numberSliceEqual([1], [1, 2])).toBe(false);
  });
});

describe("approvedSliceEqual", () => {
  it("ignores key order", () => {
    expect(approvedSliceEqual({ 2: "LWIN2", 1: "LWIN1" }, { 1: "LWIN1", 2: "LWIN2" })).toBe(true);
  });

  it("sees a different lwin_id for the same row as different", () => {
    expect(approvedSliceEqual({ 1: "LWIN1" }, { 1: "LWIN9" })).toBe(false);
  });
});

const BOUNDS = [{ index: 1, startRow: 1, endRow: 100 }];

function failedDuplicate(overrides: Partial<ChunkUploadState> = {}): ChunkUploadState[] {
  return [
    {
      index: 1,
      status: "failed",
      batchId: null,
      error: "identical to chunk 2",
      code: "duplicate_chunk_content",
      sentOverridesSnapshot: {},
      sentRejectedLwinRowsSnapshot: [],
      sentApprovedLwinRowsSnapshot: {},
      ...overrides,
    },
  ];
}

function matched(rowNumber: number, lwinScore: number, lwinDisplayName: string | null): MatchedLwinRowEntry {
  return { rowNumber, lwinId: `LWIN-${rowNumber}`, lwinDisplayName, lwinScore };
}

const EMPTY = { rowOverrides: {}, rejectedLwinRows: new Set<number>(), matchedRows: [] as MatchedLwinRowEntry[] };

describe("computeUnresolvedDuplicateChunkContentIndexes", () => {
  it("holds the chunk unresolved while nothing has changed since the failed attempt", () => {
    expect(
      computeUnresolvedDuplicateChunkContentIndexes({
        chunkUpload: failedDuplicate(),
        chunkBreakdown: BOUNDS,
        ...EMPTY,
      }),
    ).toEqual(new Set([1]));
  });

  it("releases the chunk once an override inside its range changes", () => {
    expect(
      computeUnresolvedDuplicateChunkContentIndexes({
        chunkUpload: failedDuplicate(),
        chunkBreakdown: BOUNDS,
        ...EMPTY,
        rowOverrides: { 5: { quantity: "6" } },
      }),
    ).toEqual(new Set());
  });

  it("ignores an override outside the chunk's own [startRow, endRow] range", () => {
    expect(
      computeUnresolvedDuplicateChunkContentIndexes({
        chunkUpload: failedDuplicate(),
        chunkBreakdown: BOUNDS,
        ...EMPTY,
        rowOverrides: { 500: { quantity: "6" } },
      }),
    ).toEqual(new Set([1]));
  });

  it("releases the chunk on a rejection change alone — a rejection namespaces the digest too", () => {
    expect(
      computeUnresolvedDuplicateChunkContentIndexes({
        chunkUpload: failedDuplicate(),
        chunkBreakdown: BOUNDS,
        ...EMPTY,
        rejectedLwinRows: new Set([7]),
      }),
    ).toEqual(new Set());
  });

  it("releases the chunk on an approved-match change alone", () => {
    expect(
      computeUnresolvedDuplicateChunkContentIndexes({
        chunkUpload: failedDuplicate(),
        chunkBreakdown: BOUNDS,
        ...EMPTY,
        matchedRows: [matched(9, LWIN_APPLY_MIN_SCORE, "Domaine A 2020")],
      }),
    ).toEqual(new Set());
  });

  it("never counts an apply-eligible match with no display identity as approved", () => {
    expect(
      computeUnresolvedDuplicateChunkContentIndexes({
        chunkUpload: failedDuplicate(),
        chunkBreakdown: BOUNDS,
        ...EMPTY,
        matchedRows: [matched(9, LWIN_APPLY_MIN_SCORE, null)],
      }),
    ).toEqual(new Set([1]));
  });

  it("never counts a below-apply-threshold match as approved", () => {
    expect(
      computeUnresolvedDuplicateChunkContentIndexes({
        chunkUpload: failedDuplicate(),
        chunkBreakdown: BOUNDS,
        ...EMPTY,
        matchedRows: [matched(9, LWIN_APPLY_MIN_SCORE - 0.1, "Domaine A 2020")],
      }),
    ).toEqual(new Set([1]));
  });

  it("ignores chunks failing for any other reason", () => {
    expect(
      computeUnresolvedDuplicateChunkContentIndexes({
        chunkUpload: failedDuplicate({ code: "chunk_content_mismatch" }),
        chunkBreakdown: BOUNDS,
        ...EMPTY,
      }),
    ).toEqual(new Set());
  });

  it("is empty for the plain (non-chunked) path, which has no chunk upload at all", () => {
    expect(
      computeUnresolvedDuplicateChunkContentIndexes({
        chunkUpload: null,
        chunkBreakdown: undefined,
        ...EMPTY,
      }),
    ).toEqual(new Set());
  });
});
