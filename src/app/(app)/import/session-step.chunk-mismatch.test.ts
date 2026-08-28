// Sol round-2 audit (2026-08-27) finding 3: chunk_content_mismatch is a
// TERMINAL error from confirmImportBatch (batch-service.ts) — retrying
// re-sends the exact same chunk content and digest, so it fails the same
// way every time. Before this fix, confirmChunkedSession discarded the
// error CODE entirely and always returned a generic "you can retry it
// below" message, even though the server's own message already explains
// the only real way forward (revert the existing batch first).
import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmChunkedSession, type ChunkUploadState, type ChunkedPlanState } from "./session-step";

const PLAN: ChunkedPlanState = {
  headerRecord: "producer,name,quantity",
  chunkTotal: 1,
  chunks: [{ index: 1, startRow: 1, endRow: 2, text: "producer,name,quantity\nA,B,1\n" }],
  sourceSha256: "a".repeat(64),
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("confirmChunkedSession — chunk_content_mismatch propagation (Sol round-2 audit finding 3)", () => {
  it("surfaces the server's own message (never the generic retry copy) and tags the chunk with the typed code", async () => {
    const serverMessage =
      "Chunk 1 of this import session was already confirmed with different content or row fixes. " +
      "Revert that import before re-uploading a corrected version of this chunk.";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/import/sessions")) return jsonResponse(201, { sessionId: "session-new" });
        return jsonResponse(409, { error: { code: "chunk_content_mismatch", message: serverMessage } });
      }),
    );

    const progressStates: ChunkUploadState[][] = [];
    const result = await confirmChunkedSession({
      plan: PLAN,
      initialUpload: [{ index: 1, status: "pending", batchId: null, error: null, code: null }],
      existingSessionId: null,
      fileLabel: "cellar.csv",
      timestampsRef: { current: [] },
      onSessionId: () => {},
      onProgress: (upload) => progressStates.push(upload),
    });

    expect(result).toEqual({ ok: false, error: serverMessage });
    const finalChunk = progressStates.at(-1)?.find((c) => c.index === 1);
    expect(finalChunk).toMatchObject({ status: "failed", code: "chunk_content_mismatch", error: serverMessage });
  });

  it("keeps the generic, retry-inviting message for every OTHER upload failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/import/sessions")) return jsonResponse(201, { sessionId: "session-new" });
        return jsonResponse(500, { error: { code: "internal_error", message: "Something broke." } });
      }),
    );

    const progressStates: ChunkUploadState[][] = [];
    const result = await confirmChunkedSession({
      plan: PLAN,
      initialUpload: [{ index: 1, status: "pending", batchId: null, error: null, code: null }],
      existingSessionId: null,
      fileLabel: "cellar.csv",
      timestampsRef: { current: [] },
      onSessionId: () => {},
      onProgress: (upload) => progressStates.push(upload),
    });

    expect(result).toEqual({ ok: false, error: "Chunk 1 of 1 failed to upload — you can retry it below." });
    const finalChunk = progressStates.at(-1)?.find((c) => c.index === 1);
    expect(finalChunk).toMatchObject({ status: "failed", code: "internal_error", error: "Something broke." });
  });
});
