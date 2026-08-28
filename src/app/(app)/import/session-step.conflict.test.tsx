// Sol round-3/4 regression: a duplicate-content conflict during a chunked
// confirm must (a) hard-stop instead of adopting the chunk, and (b) mark
// the chunk itself "failed" — never leave it frozen at "uploading".
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  confirmChunkedSession,
  type ChunkUploadState,
  type ChunkedPlanState,
} from "./session-step";
import { buildImportAnywayOverride } from "./import-client";
import { CONFLICT_UNDISPLAYED_NOTE } from "./conflicting-batches";
import type { CanonicalHeader } from "@/domains/import/constants";
import type { RowOverrides } from "@/domains/import/preview-service";

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
  //
  // Round-8 audit finding 5: the version of this test that used to live
  // here was canned — a single chunk at index 1, run through TWICE in a
  // `for` loop, each iteration getting its OWN fresh mock with no shared
  // uniqueness state between the two passes. It never actually proved two
  // SIBLING chunks can both reach create in the SAME run without
  // colliding with each other — it only proved each override, taken in
  // isolation, would satisfy a mock that always treated ANY differing
  // JSON as success. Rewritten as a real two-chunk run: a plan with
  // chunks at index 1 and 2 sharing an IDENTICAL grid (same producer/name/
  // quantity), driven through ONE confirmChunkedSession call, against a
  // server mock that tracks every content_sha256-equivalent digest
  // (file text + this request's own localized overrides JSON) it has
  // seen and returns a 23505-style sibling conflict on a repeat — exactly
  // the invariant the real create_import_batch RPC's unique index enforces.
  it("two sibling chunks with an IDENTICAL grid, both going through Import-anyway in one run, generate DISTINCT overrides and both reach create with distinct digests", async () => {
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
    // Two chunks, identical bytes (a genuine repeated segment), disjoint
    // global row ranges (chunk 2 starts where chunk 1 ends).
    const SIBLING_PLAN: ChunkedPlanState = {
      headerRecord: "producer,name,quantity",
      chunkTotal: 2,
      chunks: [
        { index: 1, startRow: 1, endRow: 1, text: "producer,name,quantity\nA,B,1\n" },
        { index: 2, startRow: 2, endRow: 2, text: "producer,name,quantity\nA,B,1\n" },
      ],
      sourceSha256: "b".repeat(64),
    };

    // Each chunk's own "Import anyway" click, exactly as import-client.tsx's
    // handleImportAnyway builds it — keyed by that chunk's own GLOBAL
    // startRow, not a hardcoded row 1.
    const chunkOneOverride = buildImportAnywayOverride(
      1,
      { rowNumber: SIBLING_PLAN.chunks[0].startRow, rawText: firstRowRawText },
      [],
    );
    const chunkTwoOverride = buildImportAnywayOverride(
      2,
      { rowNumber: SIBLING_PLAN.chunks[1].startRow, rawText: firstRowRawText },
      [],
    );
    expect(chunkOneOverride).toMatchObject({ ok: true, overridePatch: { 1: { producer: "A" } } });
    // Distinct subset size for chunkIndex 2 (producer + the next non-blank
    // field, name) — the same variation this mechanism has always relied
    // on, now proven across two chunks driven together instead of two
    // isolated single-chunk runs.
    expect(chunkTwoOverride).toMatchObject({ overridePatch: { 2: { producer: "A", name: "B" } } });
    expect(chunkOneOverride).not.toEqual(chunkTwoOverride);

    const combinedOverrides: RowOverrides = {
      ...(chunkOneOverride?.ok ? chunkOneOverride.overridePatch : {}),
      ...(chunkTwoOverride?.ok ? chunkTwoOverride.overridePatch : {}),
    };

    // Tracks every digest it has ever seen (file text + this request's own
    // localized overrides JSON) — a repeat digest is exactly what a real
    // 23505 on (restaurant_id, content_sha256) would report as a sibling.
    const seenDigests = new Map<string, number>();
    const digestsRecorded: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/import/sessions")) return jsonResponse(201, { sessionId: "session-new" });
        const form = init?.body as FormData;
        const chunkIndex = Number(form.get("chunkIndex"));
        const chunkText = SIBLING_PLAN.chunks.find((c) => c.index === chunkIndex)!.text;
        const overridesRaw = form.get("rowOverrides");
        const overridesJson = typeof overridesRaw === "string" ? overridesRaw : "";
        const digest = createHash("sha256").update(`${chunkText}|${overridesJson}`).digest("hex");
        digestsRecorded.push(digest);
        const firstSeenChunkIndex = seenDigests.get(digest);
        if (firstSeenChunkIndex !== undefined) {
          return jsonResponse(200, {
            alreadyExists: true,
            sessionId: "session-new",
            chunkIndex: firstSeenChunkIndex,
            batchId: `b-sibling-${firstSeenChunkIndex}`,
          });
        }
        seenDigests.set(digest, chunkIndex);
        return jsonResponse(201, { alreadyExists: false, batchId: `b-chunk-${chunkIndex}` });
      }),
    );

    const result = await confirmChunkedSession({
      plan: SIBLING_PLAN,
      initialUpload: SIBLING_PLAN.chunks.map((c) => ({
        index: c.index,
        status: "pending" as const,
        batchId: null,
        error: null,
        code: null,
      })),
      existingSessionId: "session-new",
      fileLabel: "cellar.csv",
      timestampsRef: { current: [] },
      rowOverrides: combinedOverrides,
      onSessionId: () => {},
      onProgress: () => {},
    });

    // Neither chunk collided with the other — both reached create.
    expect(result).toMatchObject({ ok: true });
    expect(digestsRecorded).toHaveLength(2);
    expect(new Set(digestsRecorded).size).toBe(2);
  });
});

// WARN 5 (round-9/10 audit): duplicate_race_retry is retryable BY DESIGN,
// but nothing used to bound how many times in a row it could recur for the
// SAME chunk — a durably unresolvable rival produced an endless human
// "retry upload" loop with no better affordance. confirmChunkedSession now
// counts consecutive duplicate_race_retry failures per chunk (persisted on
// ChunkUploadState.duplicateRaceRetryCount, carried across manual retries
// via `initialUpload` exactly like every other per-chunk field) and
// escalates to the distinct terminal duplicate_race_retry_exhausted code
// once DUPLICATE_RACE_RETRY_LIMIT is reached.
describe("confirmChunkedSession — bounded escalation for duplicate_race_retry (round-9/10 audit, WARN 5)", () => {
  function duplicateRaceRetryResponse() {
    return jsonResponse(422, {
      error: {
        code: "duplicate_race_retry",
        message: "Another import attempt for this file is being cleaned up — please retry the upload.",
      },
    });
  }

  it("stays on the retryable duplicate_race_retry code and generic message for the first two consecutive attempts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/import/sessions")) return jsonResponse(201, { sessionId: "session-new" });
        return duplicateRaceRetryResponse();
      }),
    );

    let upload: ChunkUploadState[] = [{ index: 1, status: "pending", batchId: null, error: null, code: null }];
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const result = await confirmChunkedSession({
        plan: PLAN,
        initialUpload: upload,
        existingSessionId: "session-new",
        fileLabel: "cellar.csv",
        timestampsRef: { current: [] },
        onSessionId: () => {},
        onProgress: (u) => {
          upload = u;
        },
      });
      expect(result).toMatchObject({ ok: false, error: "Chunk 1 of 1 failed to upload — you can retry it below." });
      expect(upload[0]).toMatchObject({ code: "duplicate_race_retry", duplicateRaceRetryCount: attempt });
    }
  });

  it("escalates to the terminal duplicate_race_retry_exhausted code once DUPLICATE_RACE_RETRY_LIMIT consecutive attempts are reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/import/sessions")) return jsonResponse(201, { sessionId: "session-new" });
        return duplicateRaceRetryResponse();
      }),
    );

    let upload: ChunkUploadState[] = [{ index: 1, status: "pending", batchId: null, error: null, code: null }];
    let lastResult: Awaited<ReturnType<typeof confirmChunkedSession>> | undefined;
    // Three manual retries in a row — DUPLICATE_RACE_RETRY_LIMIT.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      lastResult = await confirmChunkedSession({
        plan: PLAN,
        initialUpload: upload,
        existingSessionId: "session-new",
        fileLabel: "cellar.csv",
        timestampsRef: { current: [] },
        onSessionId: () => {},
        onProgress: (u) => {
          upload = u;
        },
      });
    }

    expect(upload[0]).toMatchObject({ code: "duplicate_race_retry_exhausted", duplicateRaceRetryCount: 3 });
    expect(lastResult).toMatchObject({ ok: false });
    if (lastResult && !lastResult.ok) {
      expect(lastResult.error).toMatch(/still conflicts with another live import.*after 3 attempts/i);
      // Terminal — the server's own escalation message is shown verbatim,
      // never the generic "you can retry it below."
      expect(lastResult.error).not.toMatch(/you can retry it below/i);
    }
  });

  it("resets the count when a DIFFERENT code interrupts the streak", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/import/sessions")) return jsonResponse(201, { sessionId: "session-new" });
        call += 1;
        // First attempt: duplicate_race_retry. Second: a DIFFERENT,
        // unrelated retryable failure (no typed code). Third: duplicate_
        // race_retry again — count must have reset to 1, not continued to 2.
        if (call === 2) return jsonResponse(500, { error: { message: "Temporary server error." } });
        return duplicateRaceRetryResponse();
      }),
    );

    let upload: ChunkUploadState[] = [{ index: 1, status: "pending", batchId: null, error: null, code: null }];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await confirmChunkedSession({
        plan: PLAN,
        initialUpload: upload,
        existingSessionId: "session-new",
        fileLabel: "cellar.csv",
        timestampsRef: { current: [] },
        onSessionId: () => {},
        onProgress: (u) => {
          upload = u;
        },
      });
    }

    expect(upload[0]).toMatchObject({ code: "duplicate_race_retry", duplicateRaceRetryCount: 1 });
  });

  // WARN 4 (round-13 audit): a 200 alreadyExists response for the WRONG
  // session/chunk slot is a FOURTH transition that isn't a duplicate_race_
  // retry failure either — it used to spread the prior chunk unchanged
  // (`...c`), silently carrying the count forward, so
  // `race, alreadyExists (wrong chunk), race` wrongly counted the second
  // race as attempt two instead of resetting first, same bug as the
  // network-error case below.
  it("resets the count on a 200 alreadyExists response for the WRONG session/chunk slot too", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/import/sessions")) return jsonResponse(201, { sessionId: "session-new" });
        call += 1;
        // First attempt: duplicate_race_retry. Second: a 200 alreadyExists
        // naming a DIFFERENT chunk slot in THIS SAME session — a sibling
        // chunk carrying identical bytes, never this chunk's own
        // confirmation (sameSession branch, hard stop with
        // duplicate_chunk_content). Third: duplicate_race_retry again —
        // count must have reset to 1, not continued to 2.
        if (call === 2) {
          return jsonResponse(200, { alreadyExists: true, sessionId: "session-new", chunkIndex: 2, batchId: "sibling-batch" });
        }
        return duplicateRaceRetryResponse();
      }),
    );

    let upload: ChunkUploadState[] = [{ index: 1, status: "pending", batchId: null, error: null, code: null }];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await confirmChunkedSession({
        plan: PLAN,
        initialUpload: upload,
        existingSessionId: "session-new",
        fileLabel: "cellar.csv",
        timestampsRef: { current: [] },
        onSessionId: () => {},
        onProgress: (u) => {
          upload = u;
        },
      });
    }

    // duplicate_race_retry (1), alreadyExists/wrong chunk (reset to 0),
    // duplicate_race_retry (1) — never continues to 2.
    expect(upload[0]).toMatchObject({ code: "duplicate_race_retry", duplicateRaceRetryCount: 1 });
  });

  // FINDING 4 (round-11 audit): the network-error catch block used to spread
  // the prior chunk unchanged, carrying duplicateRaceRetryCount forward
  // through a network error as if it were another duplicate_race_retry —
  // so `duplicate_race_retry, duplicate_race_retry, network error,
  // duplicate_race_retry` wrongly counted as three consecutive failures
  // (reaching DUPLICATE_RACE_RETRY_LIMIT) instead of resetting after the
  // network error, like any other non-matching outcome does.
  it("does NOT escalate when a network error interrupts the streak — the count resets exactly like a different code would", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/import/sessions")) return jsonResponse(201, { sessionId: "session-new" });
        call += 1;
        if (call === 3) throw new Error("network down");
        return duplicateRaceRetryResponse();
      }),
    );

    let upload: ChunkUploadState[] = [{ index: 1, status: "pending", batchId: null, error: null, code: null }];
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await confirmChunkedSession({
        plan: PLAN,
        initialUpload: upload,
        existingSessionId: "session-new",
        fileLabel: "cellar.csv",
        timestampsRef: { current: [] },
        onSessionId: () => {},
        onProgress: (u) => {
          upload = u;
        },
      });
    }

    // duplicate_race_retry (1), duplicate_race_retry (2), network error
    // (reset to 0), duplicate_race_retry (1) — never escalates to
    // duplicate_race_retry_exhausted, and the 4th attempt's count is 1, not 3.
    expect(upload[0]).toMatchObject({ code: "duplicate_race_retry", duplicateRaceRetryCount: 1 });
  });

  // FINDING 4 (round-11 audit): the SUCCESS transition used to leave
  // whatever duplicateRaceRetryCount a prior failed attempt had set — the
  // field's own contract ("cleared to 0 whenever it... succeeds") went
  // unfulfilled.
  it("clears duplicateRaceRetryCount on success, not just on a different failing code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/import/sessions")) return jsonResponse(201, { sessionId: "session-new" });
        return jsonResponse(201, { alreadyExists: false, batchId: "b-succeeded" });
      }),
    );

    // Carries a stale duplicateRaceRetryCount from a prior failed run,
    // exactly as `initialUpload` would across a manual retry.
    let upload: ChunkUploadState[] = [
      {
        index: 1,
        status: "failed",
        batchId: null,
        error: "prior failure",
        code: "duplicate_race_retry",
        duplicateRaceRetryCount: 2,
      },
    ];
    await confirmChunkedSession({
      plan: PLAN,
      initialUpload: upload,
      existingSessionId: "session-new",
      fileLabel: "cellar.csv",
      timestampsRef: { current: [] },
      onSessionId: () => {},
      onProgress: (u) => {
        upload = u;
      },
    });

    expect(upload[0]).toMatchObject({ status: "confirmed", batchId: "b-succeeded", duplicateRaceRetryCount: 0 });
  });
});

// FINDING 2 (round-11 audit): a multiple_live_batches conflict used to name
// only a candidate COUNT. The server now carries every conflicting batch's
// id/filename/status/created_at on the error's `details.conflictingBatches`
// — this pins that confirmChunkedSession captures it onto the failed
// chunk (import-client.tsx renders it into the conflict panel from there).
describe("confirmChunkedSession — captures conflictingBatches from a multiple_live_batches response (round-11 audit finding 2)", () => {
  it("carries the server's conflictingBatches detail onto the failed chunk", async () => {
    const conflictingBatches = [
      { id: "batch-a", filename: "cellar.csv", status: "created", created_at: "2026-01-01T00:00:00Z" },
      { id: "batch-b", filename: "cellar.csv", status: "applying", created_at: "2026-01-02T00:00:00Z" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/import/sessions")) return jsonResponse(201, { sessionId: "session-new" });
        return jsonResponse(422, {
          error: {
            code: "multiple_live_batches",
            message: "This file has 2 live import batches for the same underlying content.",
            details: { conflictingBatches },
          },
        });
      }),
    );

    let upload: ChunkUploadState[] = [{ index: 1, status: "pending", batchId: null, error: null, code: null }];
    await confirmChunkedSession({
      plan: PLAN,
      initialUpload: upload,
      existingSessionId: "session-new",
      fileLabel: "cellar.csv",
      timestampsRef: { current: [] },
      onSessionId: () => {},
      onProgress: (u) => {
        upload = u;
      },
    });

    expect(upload[0].code).toBe("multiple_live_batches");
    expect(upload[0].conflictingBatches).toEqual(conflictingBatches);
  });
});

// ROUND-21 AUDIT CORRECTION (BLOCK, round-20 audit): round-17's premise —
// that a multiple_live_batches payload PARSED down to one candidate is
// "already resolved" — was wrong, and round-19 built on it. parseConflictingBatches
// (conflicting-batches.ts) drops a malformed ENTRY, a description of a
// batch; dropping that description never reverts the batch it described.
// reconcileLiveBatchesForFile (batch-service.ts) only ever emits
// multiple_live_batches when it found a genuine 2+-candidate conflict
// server-side, so a payload that parses down to one candidate on THIS
// client still names a real, unresolved conflict — the second, malformed
// candidate is simply undisplayable. Retrying without reverting anything
// hits the identical conflict every time.
describe("confirmChunkedSession — a conflict that PARSES to one candidate is NOT a resolved conflict (round-21 audit correction)", () => {
  it("keeps the terminal multiple_live_batches code when a malformed sibling entry leaves only one displayable candidate, and states honestly that one could not be shown", async () => {
    // The SERVER emitted two real candidates (conflictingBatchesCount: 2 —
    // batch-service.ts's own count, immune to this client's parsing). One
    // entry is malformed (its created_at field is missing — the exact kind
    // of response-shape drift isConflictingBatchInfo's own comment
    // describes) — parseConflictingBatches drops it, so this client's
    // DISPLAY list is down to one candidate even though the conflict itself
    // is still exactly as real as the server's count says.
    const wireConflictingBatches = [
      { id: "batch-a", filename: "cellar.csv", status: "created", created_at: "2026-01-01T00:00:00Z" },
      { id: "batch-b", filename: "cellar.csv", status: "applying" }, // malformed: no created_at
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/import/sessions")) return jsonResponse(201, { sessionId: "session-new" });
        return jsonResponse(422, {
          error: {
            code: "multiple_live_batches",
            message: "This file has 2 live import batches for the same underlying content.",
            details: { conflictingBatches: wireConflictingBatches, conflictingBatchesCount: 2 },
          },
        });
      }),
    );

    let upload: ChunkUploadState[] = [{ index: 1, status: "pending", batchId: null, error: null, code: null }];
    const result = await confirmChunkedSession({
      plan: PLAN,
      initialUpload: upload,
      existingSessionId: "session-new",
      fileLabel: "cellar.csv",
      timestampsRef: { current: [] },
      onSessionId: () => {},
      onProgress: (u) => {
        upload = u;
      },
    });

    // The malformed entry was actually dropped — proves the one-candidate
    // DISPLAY list came from the real filtering mechanism, not a fabricated
    // payload — while the server's real count (2) survives untouched.
    expect(upload[0].conflictingBatches).toEqual([wireConflictingBatches[0]]);
    expect(upload[0].conflictingBatchesCount).toBe(2);
    // The conflict is still real: the terminal code stays, blocking both
    // Retry and Confirm until the operator has actually reverted something
    // (import-client.tsx's hasRevertedAnyConflict) — this is a dead end
    // only if no other affordance exists, which is exactly what the honest
    // "not all could be shown" copy below fixes.
    expect(upload[0].code).toBe("multiple_live_batches");
    expect(upload[0].status).toBe("failed");
    // STORED text (upload[0].error, what ChunkUploadProgress renders next
    // to the chunk) and RETURNED text (result.error) both carry the
    // server's own message PLUS an honest note that not everything could
    // be displayed — round-23 audit (SIMPLIFY): CONFLICT_UNDISPLAYED_NOTE
    // names no specific count and never claims Recent imports can reach a
    // batch outside its own ten-newest window (round-22 audit BLOCK 2) —
    // never the false "already resolved" wording rounds 17-19 shipped.
    const expectedMessage = `This file has 2 live import batches for the same underlying content. ${CONFLICT_UNDISPLAYED_NOTE}`;
    expect(result).toMatchObject({ ok: false, error: expectedMessage });
    expect(upload[0].error).toBe(expectedMessage);
    expect(upload[0].error).not.toMatch(/already (been )?resolved/i);
  });

  it("still blocks with the terminal multiple_live_batches code — and pins the exact STORED message — for a genuine two-candidate list where both parse cleanly (guards against over-correcting)", async () => {
    const conflictingBatches = [
      { id: "batch-a", filename: "cellar.csv", status: "created", created_at: "2026-01-01T00:00:00Z" },
      { id: "batch-b", filename: "cellar.csv", status: "applying", created_at: "2026-01-02T00:00:00Z" },
    ];
    const serverMessage = "This file has 2 live import batches for the same underlying content.";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/import/sessions")) return jsonResponse(201, { sessionId: "session-new" });
        return jsonResponse(422, {
          error: {
            code: "multiple_live_batches",
            message: serverMessage,
            details: { conflictingBatches, conflictingBatchesCount: 2 },
          },
        });
      }),
    );

    let upload: ChunkUploadState[] = [{ index: 1, status: "pending", batchId: null, error: null, code: null }];
    const result = await confirmChunkedSession({
      plan: PLAN,
      initialUpload: upload,
      existingSessionId: "session-new",
      fileLabel: "cellar.csv",
      timestampsRef: { current: [] },
      onSessionId: () => {},
      onProgress: (u) => {
        upload = u;
      },
    });

    expect(upload[0].code).toBe("multiple_live_batches");
    expect(upload[0].conflictingBatches).toEqual(conflictingBatches);
    expect(upload[0].conflictingBatchesCount).toBe(2);
    // WARN (round-20 audit): pin the STORED message, not just the returned
    // one — the earlier version of this guard checked code/candidates/the
    // returned error but never upload[0].error, so a regression that stored
    // generic retry copy while still RETURNING the terminal message would
    // have passed. Both must carry the server's own message verbatim (no
    // undisplayed-candidate caveat here — both candidates parsed cleanly).
    expect(upload[0].error).toBe(serverMessage);
    expect(result).toMatchObject({ ok: false, error: serverMessage });
  });

  // Round-23 audit (TESTS — round-22 audit WARN 4): the round-21 fixture
  // above only ever exercised exactly ONE missing candidate (a single
  // malformed sibling). CONFLICT_UNDISPLAYED_NOTE names no specific count,
  // so it's correct whether one OR several are missing — this fixture pins
  // that against a SEVERAL-missing shape: the server's own
  // conflictingBatchesTruncated flag true (the LIVE_BATCH_LOOKUP_LIMIT cap
  // — batch-service.ts), with conflictingBatchesCount equal to the
  // displayed array's length, which the OLD count-vs-array-length check
  // alone (pre round-23) would have missed entirely (round-22 audit
  // BLOCK 2).
  it("states the same honest, count-free note for SEVERAL missing candidates (a capped read, not just a single parse-dropped entry)", async () => {
    const conflictingBatches = Array.from({ length: 5 }, (_, i) => ({
      id: `batch-${i}`,
      filename: "cellar.csv",
      status: "created",
      created_at: `2026-01-0${i + 1}T00:00:00Z`,
    }));
    const serverMessage = "This file has at least 5 live import batches for the same underlying content.";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/import/sessions")) return jsonResponse(201, { sessionId: "session-new" });
        return jsonResponse(422, {
          error: {
            code: "multiple_live_batches",
            message: serverMessage,
            // conflictingBatchesCount (5) equals conflictingBatches.length
            // (5) — several MORE live candidates exist beyond this read,
            // signaled only by conflictingBatchesTruncated.
            details: { conflictingBatches, conflictingBatchesCount: 5, conflictingBatchesTruncated: true },
          },
        });
      }),
    );

    let upload: ChunkUploadState[] = [{ index: 1, status: "pending", batchId: null, error: null, code: null }];
    const result = await confirmChunkedSession({
      plan: PLAN,
      initialUpload: upload,
      existingSessionId: "session-new",
      fileLabel: "cellar.csv",
      timestampsRef: { current: [] },
      onSessionId: () => {},
      onProgress: (u) => {
        upload = u;
      },
    });

    expect(upload[0].conflictingBatchesTruncated).toBe(true);
    const expectedMessage = `${serverMessage} ${CONFLICT_UNDISPLAYED_NOTE}`;
    expect(result).toMatchObject({ ok: false, error: expectedMessage });
    expect(upload[0].error).toBe(expectedMessage);
  });
});
