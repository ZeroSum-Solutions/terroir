// Chunk-upload predicates and transitions, now colocated with the module
// itself rather than only being exercised through import-client.test.tsx.
import { describe, expect, it } from "vitest";
import {
  isRowInConfirmedChunk,
  isRowInSkippedChunk,
  skipChunk,
  undoSkipChunk,
} from "./chunk-upload-actions";
import type { ChunkUploadState, ChunkedPlanState } from "./chunked-upload-types";

const PLAN: ChunkedPlanState = {
  headerRecord: "producer,name,quantity",
  chunkTotal: 2,
  sourceSha256: "a".repeat(64),
  chunks: [
    { index: 1, startRow: 1, endRow: 100, text: "" },
    { index: 2, startRow: 101, endRow: 200, text: "" },
  ],
};

function upload(...statuses: ChunkUploadState["status"][]): ChunkUploadState[] {
  return statuses.map((status, i) => ({ index: i + 1, status, batchId: null, error: null, code: null }));
}

describe("isRowInConfirmedChunk", () => {
  it("locks only the rows inside a confirmed chunk's own range", () => {
    const state = upload("confirmed", "failed");
    expect(isRowInConfirmedChunk(1, PLAN, state)).toBe(true);
    expect(isRowInConfirmedChunk(100, PLAN, state)).toBe(true);
    expect(isRowInConfirmedChunk(101, PLAN, state)).toBe(false);
  });

  it("is always false on the plain (non-chunked) path", () => {
    expect(isRowInConfirmedChunk(1, null, null)).toBe(false);
    expect(isRowInConfirmedChunk(1, PLAN, null)).toBe(false);
  });
});

describe("isRowInSkippedChunk", () => {
  it("is a separate predicate from the confirmed one — a skipped chunk is not confirmed", () => {
    const state = upload("skipped", "confirmed");
    expect(isRowInSkippedChunk(50, PLAN, state)).toBe(true);
    expect(isRowInConfirmedChunk(50, PLAN, state)).toBe(false);
    expect(isRowInSkippedChunk(150, PLAN, state)).toBe(false);
  });
});

describe("skipChunk / undoSkipChunk", () => {
  it("marks only the named chunk skipped, leaving the rest untouched", () => {
    const before = upload("failed", "failed");
    const after = skipChunk(before, 2);
    expect(after.map((c) => c.status)).toEqual(["failed", "skipped"]);
    expect(before.map((c) => c.status)).toEqual(["failed", "failed"]);
  });

  it("preserves error and code across a skip so undo can restore the exact failed state", () => {
    const before: ChunkUploadState[] = [
      {
        index: 1,
        status: "failed",
        batchId: null,
        error: "identical to chunk 2",
        code: "duplicate_chunk_content",
        duplicateOfChunkIndex: 2,
      },
    ];
    const skipped = skipChunk(before, 1);
    expect(skipped[0]).toMatchObject({
      status: "skipped",
      error: "identical to chunk 2",
      code: "duplicate_chunk_content",
      duplicateOfChunkIndex: 2,
    });
    expect(undoSkipChunk(skipped, 1)).toEqual(before);
  });

  it("undoes nothing on a chunk that is not skipped", () => {
    const state = upload("confirmed");
    expect(undoSkipChunk(state, 1)).toEqual(state);
  });
});
