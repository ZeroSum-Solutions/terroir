// Sol round-3/4 regression: a duplicate-content conflict during a chunked
// confirm must (a) hard-stop instead of adopting the chunk, and (b) mark
// the chunk itself "failed" — never leave it frozen at "uploading".
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  confirmChunkedSession,
  type ChunkUploadState,
  type ChunkedPlanState,
} from "./session-step";
import { buildImportAnywayOverride } from "./import-client";
import type { CanonicalHeader } from "@/domains/import/constants";

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
  // index) and explains the actual way forward.
  //
  // Round-5 audit finding 3: the guidance used to say "edit any row below
  // (even re-entering the same value)" — WRONG, since re-entering the
  // identical value reproduces the identical digest and the identical
  // collision forever. It then named the requirement explicitly: the fix
  // must DIFFER from the sibling's own value.
  //
  // Round-6 audit finding 3: round-5's "the fix must differ" framing was
  // ITSELF wrong — the DB's unique index forbids identical bare content
  // per restaurant (migrations locked), so a genuine repeated segment can
  // ONLY EVER import via a distinct digest, which makes "invent an edit
  // that differs" backwards: the real, deterministic mechanism is "Import
  // anyway" (a canonical no-op override PreviewStep generates), not an
  // operator-authored edit. Guidance now names that path instead.
  it("hard-stops with a typed duplicate_chunk_content code (never a silent confirm) when the duplicate belongs to THIS session but a DIFFERENT chunk slot, capturing this attempt's own (empty) override slice", async () => {
    const { promise, progressStates } = run({ alreadyExists: true, sessionId: "session-new", chunkIndex: 2, batchId: "b-sibling" });
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/identical to chunk 2/i);
      expect(result.error).toMatch(/import anyway/i);
      expect(result.error).not.toMatch(/actually differs/i);
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

  // Round-6 audit finding 3: "Import anyway" builds a canonical no-op
  // override (buildImportAnywayOverride, import-client.tsx) from the
  // chunk's own first data row's EXISTING value — unlike the operator-
  // authored fixes above, its value need not differ from the raw file at
  // all. It still reaches create, because the server namespaces on the
  // PRESENCE of an override, never on whether its text differs from the
  // original — this is the mechanism the whole "Import anyway" feature
  // depends on for a fully-valid duplicate chunk with no other row data to
  // edit.
  it("'Import anyway's own no-op override reaches the create path — an override need not differ from the raw file's own value to namespace the digest", async () => {
    const seenOverridesJson: string[] = [];
    vi.stubGlobal("fetch", digestAwareFetch(seenOverridesJson));

    // The chunk's own first data row is "producer=A" — buildImportAnywayOverride
    // reproduces that EXACT value, a genuine no-op relative to the file.
    const firstRowRawText: Record<CanonicalHeader, string> = {
      producer: "A",
      name: "B",
      vintage: "",
      varietal: "",
      region: "",
      country: "",
      size_ml: "",
      format: "",
      currency: "",
      quantity: "1",
      unit_cost: "",
      bin: "",
      section: "",
    };
    const built = buildImportAnywayOverride(1, { rowNumber: PLAN.chunks[0].startRow, rawText: firstRowRawText }, []);
    expect(built).toEqual({ ok: true, overridePatch: { 1: { producer: "A" } } });

    const result = await confirmChunkedSession({
      plan: PLAN,
      initialUpload: [{ index: 1, status: "failed", batchId: null, error: "conflict", code: "duplicate_chunk_content" }],
      existingSessionId: "session-new",
      fileLabel: "cellar.csv",
      timestampsRef: { current: [] },
      rowOverrides: built?.ok ? built.overridePatch : {},
      onSessionId: () => {},
      onProgress: () => {},
    });

    expect(result).toMatchObject({ ok: true });
    // A NO-OP value (identical to the raw file's own "producer" text) is
    // still sent, and still reaches create — the server hashes raw
    // overrides regardless of whether they change anything textually.
    expect(seenOverridesJson).toEqual([JSON.stringify({ "1": { producer: "A" } })]);
    expect(seenOverridesJson[0]).not.toEqual(SIBLING_OVERRIDES_JSON);
  });

  // Round-7 audit finding 2: round-6's "Import anyway" always picked the
  // SAME cell (first row, first canonical field) regardless of chunkIndex
  // — two IDENTICAL sibling chunks (same underlying rows, same grid) each
  // clicking "Import anyway" produced the IDENTICAL override, the
  // IDENTICAL namespaced digest, and the IDENTICAL 23505 collision all
  // over again. buildImportAnywayOverride is now indexed by chunkIndex, so
  // two siblings with different chunkIndex values land on DIFFERENT
  // subset sizes — distinct overrides, distinct digests — and BOTH reach
  // create, never just the first one.
  it("two identical sibling chunks' own 'Import anyway' overrides are DISTINCT — both reach create, not just the first", async () => {
    const firstRowRawText: Record<CanonicalHeader, string> = {
      producer: "A",
      name: "B",
      vintage: "",
      varietal: "",
      region: "",
      country: "",
      size_ml: "",
      format: "",
      currency: "",
      quantity: "1",
      unit_cost: "",
      bin: "",
      section: "",
    };
    const chunkOneOverride = buildImportAnywayOverride(1, { rowNumber: 1, rawText: firstRowRawText }, []);
    const chunkTwoOverride = buildImportAnywayOverride(2, { rowNumber: 1, rawText: firstRowRawText }, []);
    expect(chunkOneOverride).toMatchObject({ ok: true });
    expect(chunkTwoOverride).toMatchObject({ ok: true });
    // Distinct overrides for the IDENTICAL underlying row — chunkIndex 1
    // takes 1 cell (producer only); chunkIndex 2 takes 2 cells (producer +
    // the next non-blank field, name).
    expect(chunkOneOverride).not.toEqual(chunkTwoOverride);
    expect(chunkOneOverride).toMatchObject({ overridePatch: { 1: { producer: "A" } } });
    expect(chunkTwoOverride).toMatchObject({ overridePatch: { 1: { producer: "A", name: "B" } } });

    // Both, sent independently as this-chunk's own confirm, reach create —
    // neither collides with the OTHER sibling's own SIBLING_OVERRIDES_JSON
    // collision baseline, and (more importantly) they don't collide with
    // EACH OTHER either, since their own canonical JSON differs.
    for (const built of [chunkOneOverride, chunkTwoOverride]) {
      const seenOverridesJson: string[] = [];
      vi.stubGlobal("fetch", digestAwareFetch(seenOverridesJson));
      const result = await confirmChunkedSession({
        plan: PLAN,
        initialUpload: [{ index: 1, status: "failed", batchId: null, error: "conflict", code: "duplicate_chunk_content" }],
        existingSessionId: "session-new",
        fileLabel: "cellar.csv",
        timestampsRef: { current: [] },
        rowOverrides: built?.ok ? built.overridePatch : {},
        onSessionId: () => {},
        onProgress: () => {},
      });
      expect(result).toMatchObject({ ok: true });
    }
  });
});
