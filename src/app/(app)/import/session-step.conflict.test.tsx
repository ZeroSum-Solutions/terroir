// Sol round-3/4 regression: a duplicate-content conflict during a chunked
// confirm must (a) hard-stop instead of adopting the chunk, and (b) mark
// the chunk itself "failed" — never leave it frozen at "uploading".
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  confirmChunkedSession,
  type ChunkUploadState,
  type ChunkedPlanState,
} from "./session-step";

const PLAN: ChunkedPlanState = {
  headerRecord: "producer,name,quantity",
  chunkTotal: 1,
  chunks: [{ index: 1, startRow: 1, endRow: 2, text: "producer,name,quantity\nA,B,1\n" }],
  sourceSha256: "a".repeat(64),
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function run(confirmBody: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/import/sessions")) {
        return jsonResponse(201, { sessionId: "session-new" });
      }
      return jsonResponse(200, confirmBody);
    }),
  );
  const progressStates: ChunkUploadState[][] = [];
  const promise = confirmChunkedSession({
    plan: PLAN,
    initialUpload: [{ index: 1, status: "pending", batchId: null, error: null }],
    existingSessionId: null,
    fileLabel: "cellar.csv",
    timestampsRef: { current: [] },
    onSessionId: () => {},
    onProgress: (upload) => progressStates.push(upload),
  });
  return { promise, progressStates };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("confirmChunkedSession duplicate-content conflicts", () => {
  it("hard-stops on a standalone (null-session) duplicate and marks the chunk failed", async () => {
    const { promise, progressStates } = run({ alreadyExists: true, sessionId: null, batchId: "b-standalone" });
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/standalone batch/i);
      expect(result.conflictingSessionId).toBeUndefined();
    }
    const finalChunk = progressStates.at(-1)?.find((c) => c.index === 1);
    expect(finalChunk?.status).toBe("failed");
    expect(finalChunk?.error).toMatch(/standalone batch/i);
  });

  it("returns the conflicting session id for a cross-session duplicate and marks the chunk failed", async () => {
    const { promise, progressStates } = run({ alreadyExists: true, sessionId: "session-old", batchId: "b-old" });
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflictingSessionId).toBe("session-old");
    }
    const finalChunk = progressStates.at(-1)?.find((c) => c.index === 1);
    expect(finalChunk?.status).toBe("failed");
  });

  it("still confirms normally when the duplicate belongs to THIS session", async () => {
    const { promise, progressStates } = run({ alreadyExists: true, sessionId: "session-new", batchId: "b-same" });
    const result = await promise;
    expect(result.ok).toBe(true);
    const finalChunk = progressStates.at(-1)?.find((c) => c.index === 1);
    expect(finalChunk?.status).toBe("confirmed");
    expect(finalChunk?.batchId).toBe("b-same");
  });
});
