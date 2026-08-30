// The chunked CONFIRM half of the client-side auto-chunking flow: the
// sequential, session-scoped chunk upload driver. Extracted verbatim from
// session-step.tsx, which re-exports confirmChunkedSession and its two
// parameter/result types unchanged.
//
// Plain async, no hooks, so it is callable from any handler regardless of
// React's render/commit timing.

import { localizeApprovedLwinRows, localizeRejectedLwinRows, localizeRowOverrides } from "./chunk-localization";
import { writeStoredSession } from "./session-storage";
import type { ChunkUploadState, ChunkedPlanState } from "./chunked-upload-types";
import type { ApprovedLwinRows, RejectedLwinRows, RowOverrides } from "./review-types";

// Client-side pacing, matching /api/import/batches' own CONFIRM_RATE_LIMIT
// (10/60s, src/app/api/import/batches/route.ts) with a one-request margin
// so a same-tab retry never itself trips the server's limiter.
const CONFIRM_RATE_LIMIT_MARGIN = 9;
const CONFIRM_RATE_WINDOW_MS = 60 * 1000;

export type ConfirmChunkedSessionParams = {
  plan: ChunkedPlanState;
  /** Prior chunkUpload state, if this is a retry — any chunk already
   * "confirmed" is skipped, never re-sent. */
  initialUpload: ChunkUploadState[];
  existingSessionId: string | null;
  fileLabel: string;
  timestampsRef: { current: number[] };
  /** Inline row-fix overrides, keyed by the GLOBAL row number shown in
   * the aggregated chunked preview — localizeRowOverrides translates
   * each chunk's own slice into the LOCAL row numbers that chunk's own
   * re-upload of buildImportPreview will assign. */
  rowOverrides?: RowOverrides;
  /** Item 2 (per-row LWIN match visibility/rejection) — GLOBAL row numbers
   * (same convention as rowOverrides above) the operator rejected a LWIN
   * match on. localizeRejectedLwinRows (below) translates each chunk's own
   * slice into that chunk's own local row numbers, mirroring
   * localizeRowOverrides exactly. */
  rejectedLwinRows?: RejectedLwinRows;
  /** BLOCK 2 (Sol audit round 3, finding 2) — GLOBAL row number -> the
   * lwin_id the operator saw and accepted for that row in the aggregated
   * chunked preview (same convention as rowOverrides/rejectedLwinRows
   * above). localizeApprovedLwinRows (below) translates each chunk's own
   * slice into that chunk's own local row numbers. */
  approvedLwinRows?: ApprovedLwinRows;
  onSessionId: (sessionId: string) => void;
  onProgress: (upload: ChunkUploadState[]) => void;
};

export type ConfirmChunkedSessionResult =
  | { ok: true }
  /** conflictingSessionId is set when a chunk's content already belongs to
   * a DIFFERENT, unfinished session — the caller's job is to resume that
   * session, never to adopt the batch into the one being uploaded here. */
  | { ok: false; error: string; conflictingSessionId?: string };

/** Sequential, session-scoped chunk upload driver: creates the session (if
 * needed), then POSTs each chunk to /api/import/batches in order, pacing
 * itself under the server's rate limit. Never parallel. Safe to call again
 * after a failure with the same `plan` and the returned chunkUpload state
 * as `initialUpload` — already-confirmed chunks are skipped. */
export async function confirmChunkedSession(params: ConfirmChunkedSessionParams): Promise<ConfirmChunkedSessionResult> {
  const {
    plan,
    initialUpload,
    existingSessionId,
    fileLabel,
    timestampsRef,
    rowOverrides,
    rejectedLwinRows,
    approvedLwinRows,
    onSessionId,
    onProgress,
  } = params;
  let results = initialUpload;
  onProgress(results);

  let activeSessionId = existingSessionId;
  if (!activeSessionId) {
    try {
      const sessionResponse = await fetch("/api/import/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: fileLabel, sourceSha256: plan.sourceSha256, declaredChunkTotal: plan.chunkTotal }),
      });
      const sessionBody = await sessionResponse.json();
      if (!sessionResponse.ok) {
        return { ok: false, error: sessionBody?.error?.message ?? "Could not start the import session." };
      }
      activeSessionId = sessionBody.sessionId as string;
    } catch {
      return { ok: false, error: "Could not start the import session. Check your connection and try again." };
    }
  }
  onSessionId(activeSessionId);
  writeStoredSession({ sessionId: activeSessionId, sourceSha256: plan.sourceSha256, label: fileLabel });

  for (const chunk of plan.chunks) {
    const current = results.find((c) => c.index === chunk.index);
    // Round-5 audit finding 4: a "skipped" chunk is a deliberate, permanent
    // client-side terminal state — never re-attempted, exactly like a
    // "confirmed" one.
    if (current?.status === "confirmed" || current?.status === "skipped") continue;

    const now = Date.now();
    timestampsRef.current = timestampsRef.current.filter((t) => now - t < CONFIRM_RATE_WINDOW_MS);
    if (timestampsRef.current.length >= CONFIRM_RATE_LIMIT_MARGIN) {
      results = results.map((c) => (c.index === chunk.index ? { ...c, status: "waiting" } : c));
      onProgress(results);
      const waitMs = CONFIRM_RATE_WINDOW_MS - (now - timestampsRef.current[0]) + 250;
      await new Promise((resolve) => setTimeout(resolve, Math.max(waitMs, 0)));
    }

    results = results.map((c) => (c.index === chunk.index ? { ...c, status: "uploading" } : c));
    onProgress(results);
    timestampsRef.current.push(Date.now());

    const form = new FormData();
    const chunkFile = new File([chunk.text], `${fileLabel.replace(/\.csv$/i, "")}.part${chunk.index}.csv`, { type: "text/csv" });
    form.append("file", chunkFile);
    form.append("sessionId", activeSessionId);
    form.append("chunkIndex", String(chunk.index));
    form.append("chunkTotal", String(plan.chunkTotal));
    form.append("sourceSha256", plan.sourceSha256);
    // Round-5 audit finding 3: this chunk's own override slice, keyed by
    // the GLOBAL row numbers PreviewStep shows — captured here (before
    // localizing to this chunk's own local row numbers for the request
    // body) so a duplicate_chunk_content failure below can snapshot
    // EXACTLY what was sent, for the "did the fix actually change" gate.
    const chunkGlobalOverridesSlice: RowOverrides = {};
    if (rowOverrides) {
      for (const [key, fields] of Object.entries(rowOverrides)) {
        const globalRowNumber = Number(key);
        if (globalRowNumber >= chunk.startRow && globalRowNumber <= chunk.endRow) {
          chunkGlobalOverridesSlice[globalRowNumber] = fields;
        }
      }
      const localOverrides = localizeRowOverrides(rowOverrides, chunk);
      if (Object.keys(localOverrides).length > 0) form.append("rowOverrides", JSON.stringify(localOverrides));
    }
    // Item 2: same localize-then-append pattern as rowOverrides above.
    // WARN 5 (Sol audit round 3): this chunk's own GLOBAL rejected-row
    // slice is also captured here, for the same duplicate_chunk_content
    // snapshot reason chunkGlobalOverridesSlice is above — a rejection
    // changes the v2/v3 content_sha256 namespace exactly like an override
    // does (confirmImportBatch's own digest comment), so the retry gate
    // needs to see it change too.
    const chunkGlobalRejectedSlice: number[] = rejectedLwinRows
      ? Array.from(rejectedLwinRows).filter((n) => n >= chunk.startRow && n <= chunk.endRow)
      : [];
    if (chunkGlobalRejectedSlice.length > 0) {
      const localRejected = localizeRejectedLwinRows(rejectedLwinRows!, chunk);
      if (localRejected.length > 0) form.append("rejectedLwinRows", JSON.stringify(localRejected));
    }
    // BLOCK 2 (Sol audit round 3, finding 2): same localize-then-append
    // pattern, plus the same GLOBAL-slice snapshot capture as
    // chunkGlobalRejectedSlice above — an approved-match change also
    // namespaces content_sha256 (v3).
    const chunkGlobalApprovedSlice: ApprovedLwinRows = {};
    if (approvedLwinRows) {
      for (const [key, lwinId] of Object.entries(approvedLwinRows)) {
        const globalRowNumber = Number(key);
        if (globalRowNumber >= chunk.startRow && globalRowNumber <= chunk.endRow) {
          chunkGlobalApprovedSlice[globalRowNumber] = lwinId;
        }
      }
      // BLOCK 1 (round 5 fix): always send, even `{}` when this chunk has
      // zero linking matches of its own — see handleConfirm's own comment
      // in import-client.tsx for why presence (not non-emptiness) is what
      // confirm needs to fail closed correctly for THIS chunk's rows.
      const localApproved = localizeApprovedLwinRows(approvedLwinRows, chunk);
      form.append("approvedLwinRows", JSON.stringify(localApproved));
    }

    try {
      const response = await fetch("/api/import/batches", { method: "POST", body: form });
      const body = await response.json();
      if (!response.ok) {
        const code: string | null = body?.error?.code ?? null;
        const message: string = body?.error?.message ?? "Upload failed.";

        results = results.map((c) => (c.index === chunk.index ? { ...c, status: "failed", error: message, code } : c));
        onProgress(results);
        // Sol round-2 audit (2026-08-27) finding 3: chunk_content_mismatch is
        // TERMINAL — retrying re-sends this exact chunk's content and
        // digest, so it fails the exact same way every time. The server's
        // own message already explains the revert path; the generic
        // "you can retry it below" wording is actively wrong for this one
        // code, so it's used only for every other (genuinely retryable)
        // failure.
        //
        // Round-27 audit (removes the in-preview conflict-recovery panel,
        // which failed five straight audits — see docs/runbooks/
        // csv-import.md): multiple_live_batches and duplicate_race_retry are
        // both reported here, never resolved from inside this UI —
        // PreviewStep keeps Confirm/Retry available for both (the server
        // re-checks on every attempt; a retry that changes nothing simply
        // re-raises the same conflict), and recovery for multiple_live_batches
        // is through Recent imports, which no longer hides an aged-out
        // batch. duplicate_race_retry no longer escalates to an invented
        // terminal state after repeated attempts — the server defines it as
        // retryable, and the client no longer overrides that. Both codes'
        // own messages already explain the situation, so they're shown
        // verbatim here instead of the generic "you can retry it below".
        return {
          ok: false,
          error:
            code === "chunk_content_mismatch" || code === "multiple_live_batches"
              ? message
              : `Chunk ${chunk.index} of ${plan.chunkTotal} failed to upload — you can retry it below.`,
        };
      }
      // 200 (alreadyExists) can point at a batch that belongs to a
      // DIFFERENT session than the one being uploaded here — this file's
      // upload was interrupted earlier and started fresh, and this chunk's
      // content collided by hash with the OLD session's chunk. Adopting it
      // into this new session would split one file across two incomplete
      // sessions; stop and hand the original session back to the caller.
      //
      // Sol round-3 audit (2026-08-27) finding 3: a same-session match
      // whose chunk_index does NOT equal the slot being confirmed right
      // now is a SIBLING chunk carrying identical bytes (e.g. a duplicated
      // export segment) — never this chunk's own confirmation. Requiring
      // BOTH sessionId AND chunkIndex to match before treating the
      // response as "this chunk is done" closes the gap where such a
      // sibling match would otherwise mark this slot "confirmed" while no
      // batch actually claims it, silently dropping this chunk's rows.
      if (body.alreadyExists && (body.sessionId !== activeSessionId || body.chunkIndex !== chunk.index)) {
        const sameSession = body.sessionId === activeSessionId;
        // Round-4 audit finding 2: the sameSession branch used to be a
        // dead end — marked "failed" with code null, so PreviewStep
        // offered "Retry upload," which deterministically re-hits the
        // exact same (restaurant_id, content_sha256) unique index and
        // fails the same way every time (migrations are locked — the DB
        // genuinely cannot hold two live batches with identical content
        // for this restaurant), while the conflicting sibling batch sits
        // at status 'created' — not eligible for the "completed"-only
        // batch-revert action, and the session isn't revertable either
        // until its rows settle. There was no way forward.
        //
        // The fix uses the existing overrides mechanism, which already
        // provides exactly the distinguishing signal this needs: ANY
        // rowOverride on this chunk namespaces its content_sha256
        // (confirmImportBatch's own overrides-v1:<h(overrides)>:<h(file)>
        // format), so it no longer collides with the sibling's bare-file
        // digest. Tagged with a distinct TERMINAL code — duplicate_chunk_
        // content — so PreviewStep never offers a "Retry upload" that
        // would just fail identically again, and the guidance below tells
        // the operator the actual way forward: edit a row so its fix
        // actually DIFFERS from the sibling's, or leave it alone (or skip
        // it — PreviewStep's own "Skip this chunk" control) if the
        // duplication was accidental. This chunk's rows are NOT locked by
        // this — isRowInConfirmedChunk only locks rows belonging to a
        // chunk whose status is 'confirmed', and this one is 'failed' —
        // so the operator can act on that guidance immediately, and a
        // subsequent confirm carrying a genuinely DIFFERENT override
        // reaches the create path normally (the same-session exclusion in
        // findLiveBatchByUnderlyingFile already keeps this sibling from
        // short-circuiting that retry as a false duplicate).
        //
        // Round-6 audit finding 3: round-5's guidance ("edit a row so its
        // fix actually DIFFERS from the sibling's own value") was itself
        // wrong in a deeper way than just its wording — the DB's unique
        // index forbids identical bare content per restaurant (migrations
        // are locked), so a GENUINE repeated segment can only EVER import
        // via a distinct digest at all, and the round-5 guidance never
        // named the one deterministic, always-available way to produce
        // one: "Import anyway" below (ChunkUploadProgress) generates a
        // canonical no-op override from this chunk's own first data row,
        // which namespaces the digest without requiring the operator to
        // invent an edit — the only mechanism that also works for a fully
        // VALID duplicate chunk with no error row to ever edit in the
        // first place. A genuine row-level fix (an actual validation
        // error, unrelated to this collision) still works exactly as
        // before and also changes the digest; this guidance no longer
        // claims editing is the only path, or that re-entering identical
        // text can never work — "Import anyway" IS re-sending this exact
        // content, deliberately, through a namespaced digest.
        const conflictError = !body.sessionId
          ? `Chunk ${chunk.index} was already imported as a standalone batch. Revert that batch under ` +
            "Recent imports before re-uploading this file."
          : sameSession
            ? `Chunk ${chunk.index}'s content is identical to chunk ${body.chunkIndex}, already imported in this ` +
              "session — the database can't hold two imports with identical content. If this is a genuine " +
              `repeated segment that needs to import again, use "Import anyway" below to import it as a separate ` +
              "tracked upload. If the duplication was accidental, no action is needed, or use \"Skip this chunk\" " +
              `below — chunk ${body.chunkIndex} already imported these rows.`
            : "This file was already partially uploaded as a different, unfinished import — resuming that import " +
              "instead of starting a second one.";
        const conflictCode = sameSession ? "duplicate_chunk_content" : null;
        results = results.map((c) =>
          c.index === chunk.index
            ? {
                ...c,
                status: "failed",
                error: conflictError,
                code: conflictCode,
                // Round-5 audit finding 3: only meaningful (and only ever
                // read) for duplicate_chunk_content — the exact override
                // slice this failed attempt sent, for the "did it actually
                // change" gate PreviewStep computes on retry.
                sentOverridesSnapshot: conflictCode === "duplicate_chunk_content" ? chunkGlobalOverridesSlice : c.sentOverridesSnapshot,
                // WARN 5 (Sol audit round 3): same reasoning, for the
                // rejected/approved slices — see ChunkUploadState's own
                // comment on these two fields for why both must be
                // snapshotted too, not just overrides.
                sentRejectedLwinRowsSnapshot:
                  conflictCode === "duplicate_chunk_content" ? chunkGlobalRejectedSlice : c.sentRejectedLwinRowsSnapshot,
                sentApprovedLwinRowsSnapshot:
                  conflictCode === "duplicate_chunk_content" ? chunkGlobalApprovedSlice : c.sentApprovedLwinRowsSnapshot,
                duplicateOfChunkIndex: conflictCode === "duplicate_chunk_content" ? (body.chunkIndex as number) : c.duplicateOfChunkIndex,
              }
            : c,
        );
        onProgress(results);
        // sessionId null = the identical bytes were confirmed earlier as a
        // STANDALONE (sessionless) batch. There is no session to resume and
        // adopting the batch here would strand it outside this session.
        if (!body.sessionId) {
          return { ok: false, error: conflictError };
        }
        // Same session but the WRONG chunk slot — there is no "other
        // session" to resume, this is a hard stop the operator must
        // resolve directly, never a conflictingSessionId redirect.
        if (sameSession) {
          return { ok: false, error: conflictError };
        }
        return { ok: false, error: conflictError, conflictingSessionId: body.sessionId as string };
      }

      // 201 (new), or 200 (alreadyExists: THIS exact chunk slot, in THIS
      // session, was already confirmed) — either way this chunk is now
      // live server-side. Round-6 audit finding 7: also clears
      // sentOverridesSnapshot/duplicateOfChunkIndex, which a PRIOR failed
      // attempt on this same chunk may have set — leaving them would let a
      // now-irrelevant conflict snapshot survive into the confirmed state,
      // for no purpose (both fields are read only while status is
      // "failed"/"skipped").
      results = results.map((c) =>
        c.index === chunk.index
          ? {
              ...c,
              status: "confirmed",
              batchId: body.batchId as string,
              error: null,
              code: null,
              sentOverridesSnapshot: undefined,
              sentRejectedLwinRowsSnapshot: undefined,
              sentApprovedLwinRowsSnapshot: undefined,
              duplicateOfChunkIndex: undefined,
            }
          : c,
      );
      onProgress(results);
    } catch {
      results = results.map((c) => (c.index === chunk.index ? { ...c, status: "failed", error: "Network error.", code: null } : c));
      onProgress(results);
      return {
        ok: false,
        error: `Chunk ${chunk.index} of ${plan.chunkTotal} failed to upload — check your connection and retry.`,
      };
    }
  }

  return { ok: true };
}
