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
  //
  // Round-5 audit finding 3: the guidance used to say "edit any row below
  // (even re-entering the same value)" — WRONG, since re-entering the
  // identical value reproduces the identical digest and the identical
  // collision forever. It now names the requirement explicitly: the fix
  // must DIFFER from the sibling's own value.
  it("hard-stops with a typed duplicate_chunk_content code (never a silent confirm) when the duplicate belongs to THIS session but a DIFFERENT chunk slot, capturing this attempt's own (empty) override slice", async () => {
    const { promise, progressStates } = run({ alreadyExists: true, sessionId: "session-new", chunkIndex: 2, batchId: "b-sibling" });
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/identical to chunk 2/i);
      expect(result.error).toMatch(/actually differs/i);
      expect(result.error).not.toMatch(/edit any row/i);
      // No "other session" to resume — this is a same-session, wrong-slot
      // hard stop, not a cross-session redirect.
      expect(result.conflictingSessionId).toBeUndefined();
    }
    const finalChunk = progressStates.at(-1)?.find((c) => c.index === 1);
    expect(finalChunk?.status).toBe("failed");
    expect(finalChunk?.batchId).toBeNull();
    expect(finalChunk?.code).toBe("duplicate_chunk_content");
    // This attempt carried no rowOverrides — the captured snapshot is
    // empty, matching what was actually sent.
    expect(finalChunk?.sentOverridesSnapshot).toEqual({});
    expect(finalChunk?.duplicateOfChunkIndex).toBe(2);
  });
});

// Round-4 audit finding 2: the whole point of the duplicate_chunk_content
// terminal code (as opposed to a bare dead end) is that it's recoverable
// from inside this same UI — a rowOverride namespaces this chunk's own
// content_sha256, so a subsequent confirm carrying it reaches the create
// path normally rather than re-hitting the same conflict.
//
// Round-5 audit finding 3: the ORIGINAL version of this test's mock server
// treated "an override was sent AT ALL" as success — `if
// (form.has("rowOverrides")) return 201`, regardless of what the override
// actually contained. That never proved the digest differs, and in fact
// mirrored the exact client-side bug this finding fixed (Retry appearing
// for ANY override, even one identical to the collision that produced the
// conflict). Replaced with a mock that models the real server property
// that matters: an unchanged canonical overrides JSON produces an
// unchanged namespaced digest (batch-service.ts's overrides-v1:<h(overrides)>:<h(file)>
// format), hence the identical collision — only a JSON payload that
// genuinely DIFFERS from the sibling's own succeeds.
describe("confirmChunkedSession — Retry only reaches create when the override actually DIFFERS from the sibling's (round-5 audit finding 3)", () => {
  const SIBLING_OVERRIDES_JSON = JSON.stringify({ "1": { quantity: "99" } });

  function digestAwareFetch(seenOverridesJson: string[]) {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/import/sessions")) return jsonResponse(201, { sessionId: "session-new" });
      const form = init?.body as FormData;
      const overridesRaw = form.get("rowOverrides");
      const overridesJson = typeof overridesRaw === "string" ? overridesRaw : null;
      if (overridesJson) seenOverridesJson.push(overridesJson);
      if (overridesJson && overridesJson !== SIBLING_OVERRIDES_JSON) {
        return jsonResponse(201, { alreadyExists: false, batchId: "b-fixed" });
      }
      // No override, or the SAME JSON the sibling already used — the
      // sibling conflict recurs exactly as before.
      return jsonResponse(200, { alreadyExists: true, sessionId: "session-new", chunkIndex: 2, batchId: "b-sibling" });
    });
  }

  it("re-sending the SAME override the sibling already used still collides — identical canonical JSON, identical digest", async () => {
    const seenOverridesJson: string[] = [];
    vi.stubGlobal("fetch", digestAwareFetch(seenOverridesJson));

    const result = await confirmChunkedSession({
      plan: PLAN,
      initialUpload: [{ index: 1, status: "failed", batchId: null, error: "conflict", code: "duplicate_chunk_content" }],
      existingSessionId: "session-new",
      fileLabel: "cellar.csv",
      timestampsRef: { current: [] },
      // PLAN's only chunk covers global rows 1-2, so global row 1 -> this
      // chunk's own local row 1 — an override value IDENTICAL to the
      // sibling's own ("99").
      rowOverrides: { 1: { quantity: "99" } },
      onSessionId: () => {},
      onProgress: () => {},
    });

    expect(result.ok).toBe(false);
    expect(seenOverridesJson).toEqual([SIBLING_OVERRIDES_JSON]);
  });

  it("reaches the create path once the override genuinely DIFFERS from the sibling's own value — different canonical JSON, different digest", async () => {
    const seenOverridesJson: string[] = [];
    vi.stubGlobal("fetch", digestAwareFetch(seenOverridesJson));

    const result = await confirmChunkedSession({
      plan: PLAN,
      initialUpload: [{ index: 1, status: "failed", batchId: null, error: "conflict", code: "duplicate_chunk_content" }],
      existingSessionId: "session-new",
      fileLabel: "cellar.csv",
      timestampsRef: { current: [] },
      rowOverrides: { 1: { quantity: "100" } },
      onSessionId: () => {},
      onProgress: () => {},
    });

    expect(result).toMatchObject({ ok: true });
    expect(seenOverridesJson).toEqual([JSON.stringify({ "1": { quantity: "100" } })]);
    expect(seenOverridesJson[0]).not.toEqual(SIBLING_OVERRIDES_JSON);
  });
});
