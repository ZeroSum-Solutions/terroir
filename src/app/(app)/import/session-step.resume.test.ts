// Round-6 audit finding 4(c): a fresh re-upload attempt (the only "resume"
// mechanism this UI has — a page reload discards chunkedPlan/chunkUpload
// entirely) used to hard-stop the instant an already-confirmed chunk's
// bytes collided with the resumed session, jumping straight to SessionStep
// and abandoning every chunk after it — including one stuck on
// duplicate_chunk_content whose Skip/Import-anyway choice the operator
// still needs to see. confirmChunkedSessionWithResume now retries the
// remaining chunks under the verified, adopted session instead of giving
// up, so a genuinely unresolved chunk gets its own fresh confirm attempt
// and resurfaces its failure (the choice UI) rather than being silently
// skipped over.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  confirmChunkedSessionWithResume,
  type ChunkUploadState,
  type ChunkedPlanState,
} from "./session-step";

const SOURCE_SHA = "a".repeat(64);

const PLAN: ChunkedPlanState = {
  headerRecord: "producer,name,quantity",
  chunkTotal: 2,
  chunks: [
    { index: 1, startRow: 1, endRow: 2, text: "producer,name,quantity\nA,B,1\n" },
    { index: 2, startRow: 3, endRow: 4, text: "producer,name,quantity\nC,D,1\n" },
  ],
  sourceSha256: SOURCE_SHA,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("confirmChunkedSessionWithResume — adopt-and-continue (round-6 audit finding 4(c))", () => {
  it("retries the remaining chunks under the verified adopted session, resurfacing a genuinely unresolved chunk's duplicate_chunk_content failure instead of silently abandoning it", async () => {
    // Chunk 1's content already belongs to "session-old" (a legitimate,
    // in-progress, same-source-file session — e.g. this file was uploaded
    // before, and this is a fresh re-upload attempt after a page reload
    // lost all local state). Chunk 2's content collides with a DIFFERENT
    // chunk of session-old (chunk 3) — a genuine unresolved
    // duplicate_chunk_content, never automatically resolvable.
    const batchCalls: Array<{ sessionId: string; chunkIndex: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/import/sessions")) {
          return jsonResponse(201, { sessionId: "session-fresh" });
        }
        if (url === "/api/import/sessions/session-old") {
          return jsonResponse(200, { status: "in_progress", sourceSha256: SOURCE_SHA });
        }
        if (url.endsWith("/api/import/batches")) {
          const form = init?.body as FormData;
          const sessionId = form.get("sessionId") as string;
          const chunkIndex = form.get("chunkIndex") as string;
          batchCalls.push({ sessionId, chunkIndex });

          if (chunkIndex === "1") {
            if (sessionId === "session-fresh") {
              // Cross-session conflict: this exact content already lives
              // under session-old, chunk slot 1.
              return jsonResponse(200, { alreadyExists: true, sessionId: "session-old", chunkIndex: 1, batchId: "b-old-1" });
            }
            if (sessionId === "session-old") {
              // Retried under the adopted session — exact slot match, done.
              return jsonResponse(200, { alreadyExists: true, sessionId: "session-old", chunkIndex: 1, batchId: "b-old-1" });
            }
          }
          if (chunkIndex === "2" && sessionId === "session-old") {
            // A GENUINE, unresolved sibling conflict within the adopted
            // session — never auto-resolvable, must surface as a failure.
            return jsonResponse(200, { alreadyExists: true, sessionId: "session-old", chunkIndex: 3, batchId: "b-old-3" });
          }
          throw new Error(`unexpected batch call: session=${sessionId} chunk=${chunkIndex}`);
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    const progressStates: ChunkUploadState[][] = [];
    const sessionIds: string[] = [];
    const result = await confirmChunkedSessionWithResume({
      plan: PLAN,
      initialUpload: PLAN.chunks.map((c) => ({ index: c.index, status: "pending" as const, batchId: null, error: null, code: null })),
      existingSessionId: null,
      fileLabel: "cellar.csv",
      timestampsRef: { current: [] },
      onSessionId: (id) => sessionIds.push(id),
      onProgress: (upload) => progressStates.push(upload),
    });

    // Never silently jumps to "ok" or abandons chunk 2 — the genuinely
    // unresolved conflict surfaces as a failure.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/identical to chunk 3/i);
    }

    // The adopted session id was reported (twice: once for the initial
    // create, once for the adoption) — the LAST one reported is the real,
    // resumed session.
    expect(sessionIds.at(-1)).toBe("session-old");

    // Chunk 1 was retried and reached "confirmed" under the ADOPTED
    // session — never left behind as "failed" just because the FIRST
    // attempt (under the abandoned fresh session) collided.
    const finalUpload = progressStates.at(-1)!;
    expect(finalUpload.find((c) => c.index === 1)).toMatchObject({ status: "confirmed", batchId: "b-old-1" });
    // Chunk 2 is left "failed" with the typed, recoverable code — exactly
    // what PreviewStep's Skip/Import-anyway choice UI keys off.
    expect(finalUpload.find((c) => c.index === 2)).toMatchObject({ status: "failed", code: "duplicate_chunk_content" });

    // Chunk 1 was attempted under BOTH sessions (the doomed fresh one,
    // then the adopted one) — chunk 2 was attempted ONLY under the
    // adopted session, proving the retry picked up exactly where the
    // conflict left off rather than re-attempting everything from scratch.
    expect(batchCalls.filter((c) => c.chunkIndex === "1")).toHaveLength(2);
    expect(batchCalls.filter((c) => c.chunkIndex === "2")).toHaveLength(1);
    expect(batchCalls.find((c) => c.chunkIndex === "2")?.sessionId).toBe("session-old");
  });

  it("still hard-stops (never adopts) when the conflicting session does NOT verify as this file's own resumable session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/import/sessions")) return jsonResponse(201, { sessionId: "session-fresh" });
        if (url === "/api/import/sessions/session-foreign") {
          // A DIFFERENT source file's session — must never be adopted.
          return jsonResponse(200, { status: "in_progress", sourceSha256: "f".repeat(64) });
        }
        if (url.endsWith("/api/import/batches")) {
          const form = init?.body as FormData;
          if (form.get("chunkIndex") === "1") {
            return jsonResponse(200, { alreadyExists: true, sessionId: "session-foreign", chunkIndex: 1, batchId: "b-foreign-1" });
          }
          throw new Error("chunk 2 should never be attempted");
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    const result = await confirmChunkedSessionWithResume({
      plan: PLAN,
      initialUpload: PLAN.chunks.map((c) => ({ index: c.index, status: "pending" as const, batchId: null, error: null, code: null })),
      existingSessionId: null,
      fileLabel: "cellar.csv",
      timestampsRef: { current: [] },
      onSessionId: () => {},
      onProgress: () => {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/can't be resumed for this file/i);
    }
  });

  // Round-7 audit finding 3: the gap the round-6 fix above didn't close —
  // a chunk CONFIRMED under the fresh session BEFORE a LATER chunk reveals
  // the pre-existing session was never reconciled into the adopted
  // session. Without the fix, this scenario would report `{ ok: true }`
  // with chunk 1's rows split off under the abandoned "session-fresh"
  // (never shown again — ImportClient's SessionStep only ever renders the
  // adopted session id) while chunk 2 lands under "session-old" — one file
  // silently split across two sessions.
  it("reconciles a chunk that was CONFIRMED under the fresh session before a later chunk reveals the pre-existing session — never a split-session success", async () => {
    const revertedBatchIds: string[] = [];
    const batchCalls: Array<{ sessionId: string; chunkIndex: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/import/sessions")) {
          return jsonResponse(201, { sessionId: "session-fresh" });
        }
        if (url === "/api/import/sessions/session-old") {
          return jsonResponse(200, { status: "in_progress", sourceSha256: SOURCE_SHA });
        }
        if (url.endsWith("/revert") && init?.method === "POST") {
          // e.g. "/api/import/batches/b-fresh-1/revert"
          const batchId = url.split("/").at(-2)!;
          revertedBatchIds.push(batchId);
          return jsonResponse(200, { revertedCount: 0 });
        }
        if (url.endsWith("/api/import/batches")) {
          const form = init?.body as FormData;
          const sessionId = form.get("sessionId") as string;
          const chunkIndex = form.get("chunkIndex") as string;
          batchCalls.push({ sessionId, chunkIndex });

          if (chunkIndex === "1" && sessionId === "session-fresh") {
            // Chunk 1 confirms CLEANLY under the fresh session — no
            // conflict yet. This is the batch that must be reconciled once
            // chunk 2 (below) reveals the pre-existing session.
            return jsonResponse(201, { alreadyExists: false, batchId: "b-fresh-1" });
          }
          if (chunkIndex === "2" && sessionId === "session-fresh") {
            // Chunk 2's content already belongs to session-old, chunk
            // slot 2 — the adoption trigger.
            return jsonResponse(200, { alreadyExists: true, sessionId: "session-old", chunkIndex: 2, batchId: "b-old-2" });
          }
          // Re-drive under the adopted session: BOTH chunks, including the
          // one that already succeeded under the abandoned session.
          if (chunkIndex === "1" && sessionId === "session-old") {
            return jsonResponse(201, { alreadyExists: false, batchId: "b-old-1" });
          }
          if (chunkIndex === "2" && sessionId === "session-old") {
            return jsonResponse(200, { alreadyExists: true, sessionId: "session-old", chunkIndex: 2, batchId: "b-old-2" });
          }
          throw new Error(`unexpected batch call: session=${sessionId} chunk=${chunkIndex}`);
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    const progressStates: ChunkUploadState[][] = [];
    const sessionIds: string[] = [];
    const result = await confirmChunkedSessionWithResume({
      plan: PLAN,
      initialUpload: PLAN.chunks.map((c) => ({ index: c.index, status: "pending" as const, batchId: null, error: null, code: null })),
      existingSessionId: null,
      fileLabel: "cellar.csv",
      timestampsRef: { current: [] },
      onSessionId: (id) => sessionIds.push(id),
      onProgress: (upload) => progressStates.push(upload),
    });

    // Never a split-session success: the wrapper only reports ok once
    // EVERY chunk (including the one confirmed under the abandoned
    // session) is confirmed under the SAME, adopted session.
    expect(result).toEqual({ ok: true });
    expect(sessionIds.at(-1)).toBe("session-old");

    const finalUpload = progressStates.at(-1)!;
    // Chunk 1 no longer points at its abandoned-session batch — it was
    // re-driven and now points at the adopted session's own batch.
    expect(finalUpload.find((c) => c.index === 1)).toMatchObject({ status: "confirmed", batchId: "b-old-1" });
    expect(finalUpload.find((c) => c.index === 2)).toMatchObject({ status: "confirmed", batchId: "b-old-2" });

    // The abandoned session's batch was best-effort reverted, never left
    // as an untouched, unreachable orphan.
    expect(revertedBatchIds).toEqual(["b-fresh-1"]);

    // Chunk 1 was attempted under BOTH sessions (fresh, then adopted after
    // reconciliation) — proving it was genuinely re-driven, not merely
    // left alone because it "already succeeded."
    expect(batchCalls.filter((c) => c.chunkIndex === "1")).toHaveLength(2);
    expect(batchCalls.filter((c) => c.chunkIndex === "1" && c.sessionId === "session-old")).toHaveLength(1);
  });

  // Round-8 audit finding 4: the revert call above used to be awaited
  // without ever checking `response.ok` — an HTTP-level failure (a 4xx/5xx
  // from the revert endpoint) was silently treated as success, so the
  // batch confirmed under the abandoned session was left live, resurfacing
  // as a cross-session duplicate once its chunk was re-driven. The fix
  // checks response.ok explicitly and ABORTS the whole adoption re-drive
  // (never resets/re-drives any chunk) when any revert fails, surfacing a
  // retryable error instead.
  it("aborts the adoption re-drive — never resetting or re-driving any chunk — when a cleanup revert returns a non-OK response", async () => {
    const revertAttempts: string[] = [];
    const batchCalls: Array<{ sessionId: string; chunkIndex: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/import/sessions")) {
          return jsonResponse(201, { sessionId: "session-fresh" });
        }
        if (url === "/api/import/sessions/session-old") {
          return jsonResponse(200, { status: "in_progress", sourceSha256: SOURCE_SHA });
        }
        if (url.endsWith("/revert") && init?.method === "POST") {
          const batchId = url.split("/").at(-2)!;
          revertAttempts.push(batchId);
          // HTTP-level failure — e.g. the batch was already gone, or the
          // request timed out — distinct from a network-level throw.
          return jsonResponse(500, { error: { code: "internal_error", message: "Revert failed." } });
        }
        if (url.endsWith("/api/import/batches")) {
          const form = init?.body as FormData;
          const sessionId = form.get("sessionId") as string;
          const chunkIndex = form.get("chunkIndex") as string;
          batchCalls.push({ sessionId, chunkIndex });

          if (chunkIndex === "1" && sessionId === "session-fresh") {
            // Chunk 1 confirms cleanly under the fresh session — the
            // batch that must be reconciled once chunk 2 reveals the
            // pre-existing session.
            return jsonResponse(201, { alreadyExists: false, batchId: "b-fresh-1" });
          }
          if (chunkIndex === "2" && sessionId === "session-fresh") {
            // Chunk 2's content already belongs to session-old, chunk
            // slot 2 — the adoption trigger.
            return jsonResponse(200, { alreadyExists: true, sessionId: "session-old", chunkIndex: 2, batchId: "b-old-2" });
          }
          throw new Error(`unexpected batch call: session=${sessionId} chunk=${chunkIndex} (adoption must never re-drive)`);
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    const progressStates: ChunkUploadState[][] = [];
    const sessionIds: string[] = [];
    const result = await confirmChunkedSessionWithResume({
      plan: PLAN,
      initialUpload: PLAN.chunks.map((c) => ({ index: c.index, status: "pending" as const, batchId: null, error: null, code: null })),
      existingSessionId: null,
      fileLabel: "cellar.csv",
      timestampsRef: { current: [] },
      onSessionId: (id) => sessionIds.push(id),
      onProgress: (upload) => progressStates.push(upload),
    });

    // The cleanup revert was attempted, but its failure aborts the whole
    // adoption — never a partial cleanup silently treated as success.
    expect(revertAttempts).toEqual(["b-fresh-1"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/couldn't clean up|retry the upload/i);
    }

    // No chunk was ever reset back to "pending" or re-driven under the
    // adopted session — chunk 1 stays exactly where confirmChunkedSession
    // last left it (confirmed, under the abandoned session), never
    // touched by a re-drive that never happened.
    const finalUpload = progressStates.at(-1)!;
    expect(finalUpload.find((c) => c.index === 1)).toMatchObject({ status: "confirmed", batchId: "b-fresh-1" });
    expect(batchCalls.filter((c) => c.sessionId === "session-old")).toHaveLength(0);
    // onSessionId was only ever called once, for the ORIGINAL fresh
    // session — the adopted session-old is never reported, since the
    // adoption itself was aborted before getting that far.
    expect(sessionIds).toEqual(["session-fresh"]);
  });

  it("passes through an ordinary (non-conflict) failure unchanged", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/import/sessions")) return jsonResponse(201, { sessionId: "session-fresh" });
        return jsonResponse(500, { error: { code: "internal_error", message: "Something broke." } });
      }),
    );

    const result = await confirmChunkedSessionWithResume({
      plan: PLAN,
      initialUpload: PLAN.chunks.map((c) => ({ index: c.index, status: "pending" as const, batchId: null, error: null, code: null })),
      existingSessionId: null,
      fileLabel: "cellar.csv",
      timestampsRef: { current: [] },
      onSessionId: () => {},
      onProgress: () => {},
    });

    expect(result).toEqual({ ok: false, error: "Chunk 1 of 2 failed to upload — you can retry it below." });
  });
});
