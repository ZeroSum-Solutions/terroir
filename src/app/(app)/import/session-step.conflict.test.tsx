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
    initialUpload: [{ index: 1, status: "pending", batchId: null, error: null, code: null }],
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

  it("still confirms normally when the duplicate belongs to THIS session AND this exact chunk slot", async () => {
    const { promise, progressStates } = run({ alreadyExists: true, sessionId: "session-new", chunkIndex: 1, batchId: "b-same" });
    const result = await promise;
    expect(result.ok).toBe(true);
    const finalChunk = progressStates.at(-1)?.find((c) => c.index === 1);
    expect(finalChunk?.status).toBe("confirmed");
    expect(finalChunk?.batchId).toBe("b-same");
  });

  // Sol round-3 audit (2026-08-27) finding 3: a sibling chunk of the SAME
  // session carrying identical bytes must never be mistaken for THIS
  // chunk's own confirmation — sessionId alone matching is not enough,
  // chunkIndex must match too.
  //
  // Round-4 audit finding 2: this used to be an unrecoverable dead end
  // (code null, so PreviewStep offered a "Retry upload" that would
  // deterministically fail the same way forever). It's now tagged with a
  // distinct TERMINAL code — duplicate_chunk_content — with guidance that
  // names the OTHER chunk (from body.chunkIndex, never the target's own
  // index) and explains the actual way forward: edit a row so the chunk's
  // content_sha256 is no longer identical.
  it("hard-stops with a typed duplicate_chunk_content code (never a silent confirm) when the duplicate belongs to THIS session but a DIFFERENT chunk slot", async () => {
    const { promise, progressStates } = run({ alreadyExists: true, sessionId: "session-new", chunkIndex: 2, batchId: "b-sibling" });
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/identical to chunk 2/i);
      expect(result.error).toMatch(/edit any row/i);
      // No "other session" to resume — this is a same-session, wrong-slot
      // hard stop, not a cross-session redirect.
      expect(result.conflictingSessionId).toBeUndefined();
    }
    const finalChunk = progressStates.at(-1)?.find((c) => c.index === 1);
    expect(finalChunk?.status).toBe("failed");
    expect(finalChunk?.batchId).toBeNull();
    expect(finalChunk?.code).toBe("duplicate_chunk_content");
  });
});

// Round-4 audit finding 2: the whole point of the duplicate_chunk_content
// terminal code (as opposed to a bare dead end) is that it's recoverable
// from inside this same UI — a rowOverride namespaces this chunk's own
// content_sha256, so a subsequent confirm carrying it reaches the create
// path normally rather than re-hitting the same conflict.
describe("confirmChunkedSession — recovering from duplicate_chunk_content with an override (round-4 audit finding 2)", () => {
  it("reaches the create path on a retry that carries a rowOverride for the previously-conflicting chunk", async () => {
    const formsSeen: FormData[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/import/sessions")) return jsonResponse(201, { sessionId: "session-new" });
        const form = init?.body as FormData;
        formsSeen.push(form);
        if (form.has("rowOverrides")) {
          // The override namespaces this chunk's content_sha256 — the DB's
          // unique index no longer collides with the sibling, so the create
          // path succeeds normally.
          return jsonResponse(201, { alreadyExists: false, batchId: "b-fixed" });
        }
        // No override yet — the sibling conflict recurs exactly as before.
        return jsonResponse(200, { alreadyExists: true, sessionId: "session-new", chunkIndex: 2, batchId: "b-sibling" });
      }),
    );

    const first = await confirmChunkedSession({
      plan: PLAN,
      initialUpload: [{ index: 1, status: "pending", batchId: null, error: null, code: null }],
      existingSessionId: null,
      fileLabel: "cellar.csv",
      timestampsRef: { current: [] },
      onSessionId: () => {},
      onProgress: () => {},
    });
    expect(first.ok).toBe(false);
    expect(formsSeen.every((f) => !f.has("rowOverrides"))).toBe(true);

    // Retry, now with an override on this chunk's own row 1 (PLAN's only
    // chunk covers global rows 1-2) — mirrors the operator editing the row
    // PreviewStep's guidance points them at.
    const second = await confirmChunkedSession({
      plan: PLAN,
      initialUpload: [{ index: 1, status: "failed", batchId: null, error: "conflict", code: "duplicate_chunk_content" }],
      existingSessionId: "session-new",
      fileLabel: "cellar.csv",
      timestampsRef: { current: [] },
      rowOverrides: { 1: { quantity: "99" } },
      onSessionId: () => {},
      onProgress: () => {},
    });

    expect(second).toMatchObject({ ok: true });
    expect(formsSeen.some((f) => f.has("rowOverrides"))).toBe(true);
  });
});
