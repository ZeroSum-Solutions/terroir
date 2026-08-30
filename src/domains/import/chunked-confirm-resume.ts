// The conflicting-session adoption wrapper around confirmChunkedSession —
// reconcile-before-adopt, then re-drive every chunk under the adopted
// session. Extracted verbatim from session-step.tsx, which re-exports
// confirmChunkedSessionWithResume and its result type unchanged.

import { confirmChunkedSession, type ConfirmChunkedSessionParams } from "./chunked-confirm";
import { writeStoredSession } from "./session-storage";
import type { ChunkUploadState } from "./chunked-upload-types";

// Round-6 audit finding 4(c): bounds confirmChunkedSessionWithResume's own
// conflicting-session adoption retry (see its own comment) — a defensive
// ceiling against unbounded recursion, never expected to bind in ordinary
// use (a single hop resolves the normal "resumed the wrong-but-adjacent
// session" case).
const MAX_SESSION_ADOPTION_HOPS = 3;

export type ConfirmChunkedSessionWithResumeResult = { ok: true } | { ok: false; error: string };

/** Round-6 audit finding 4(c): wraps confirmChunkedSession with the
 * conflicting-session handling import-client.tsx used to do inline.
 *
 * A fresh re-upload attempt (the ONLY "resume" mechanism this UI has — a
 * page reload discards chunkedPlan/chunkUpload entirely, so re-selecting
 * the same file and clicking Confirm again is how an operator "continues"
 * an interrupted or duplicate-content-stuck session) used to hard-stop the
 * instant ANY already-confirmed chunk's bytes collided with the resumed
 * session — jumping straight to SessionStep and silently abandoning every
 * chunk after it, including one stuck on duplicate_chunk_content whose
 * Skip/Import-anyway choice the operator still needs to see. Once the
 * conflicting session is verified as this same file's own resumable
 * session (same source hash, still in progress — anything else is a hard
 * stop the operator must resolve, not a silent redirect), this now RETRIES
 * the remaining chunks under that session id instead of giving up — so a
 * genuinely unresolved chunk gets its own fresh confirm attempt, and its
 * failure (and the choice UI) resurfaces back in PreviewStep, rather than
 * the operator being bounced into an incomplete SessionStep with no way to
 * act on it. `depth` is a defensive bound (MAX_SESSION_ADOPTION_HOPS)
 * against unbounded recursion; ordinary usage never needs more than one
 * hop.
 *
 * Round-7 audit finding 3: retrying the REMAINING chunks under the adopted
 * session, as described above, left a gap — any chunk that was already
 * CONFIRMED under the fresh (now-abandoned) session BEFORE this conflict
 * surfaced stayed exactly where it was, under the fresh session, and was
 * never re-driven. The wrapper would then report `{ ok: true }` with the
 * file's rows split across TWO sessions: the early chunk(s) live under the
 * fresh session (which the operator never sees again — ImportClient jumps
 * to SessionStep for the ADOPTED session id only), and the rest under the
 * adopted one. Any FURTHER hop compounds this the same way.
 *
 * Verified before fixing (per this finding's own instruction): does apply
 * ever start mid-session, before every chunk is confirmed? No. Apply is
 * only ever triggered by an explicit operator click on BatchStep's "Apply"
 * button or SessionStep's "Apply N row(s)" button (import-client.tsx,
 * this file) — both require first landing on a batch/session STEP, which
 * only happens after this whole confirm loop returns. Nothing in
 * confirmChunkedSession or this wrapper ever calls /apply. So every chunk
 * this function itself confirmed under the fresh session, moments earlier
 * in this SAME call (or an earlier hop of it), is provably still
 * apply_status='not_applied' — reverting it is always safe, exactly like
 * confirmImportBatch's own selfRevertAndRetry reasons about its own
 * just-created batch.
 *
 * The fix: before adopting a conflicting session, best-effort revert every
 * chunk `latestUpload` currently marks "confirmed" (POST /api/import/
 * batches/{batchId}/revert — the same endpoint BatchStep's own revert
 * button uses; revert_import_batch_v2 (0109) already allows reverting a
 * batch that's merely 'created', not only 'completed') — these are
 * unapplied confirm-stage artifacts under the session about to be
 * abandoned. Per-chunk try/catch: one revert failing never blocks
 * reverting the others, and a failure here is tolerated (not fatal) — see
 * the residual note below. Then reset each of THOSE chunks back to
 * "pending" (clearing batchId/error/code) so confirmChunkedSession's own
 * skip condition (`status === "confirmed" || "skipped"`) no longer treats
 * them as done, and re-drive EVERY chunk — the previously-confirmed ones
 * now included — under the adopted session. Skipped chunks and the
 * operator's rowOverrides (untouched, part of `params`) are preserved
 * exactly as-is: skip is a purely client-side terminal state with nothing
 * server-side to reconcile (ChunkUploadState's own comment).
 *
 * Every "confirmed" entry in `latestUpload` at this point belongs to the
 * SAME single session — whatever this call (or the immediately preceding
 * hop) was actively driving — by induction: a fresh call starts with none
 * confirmed yet, and every earlier hop already ran this same
 * reconciliation before re-driving, so no confirmed entry can be left over
 * from a session two-or-more hops back. That's what makes "revert every
 * currently-confirmed entry" correct at every hop, not just the first one.
 *
 * Round-8 audit finding 4, corrected: the residual paragraph this used to
 * end on ("a revert call above can itself fail ... tolerated here") relied
 * on re-driving under the adopted session to reconcile the orphan away —
 * but the code below only ever checked whether the `fetch` itself
 * resolved, never `response.ok`, so an HTTP-level revert failure (a 4xx/5xx
 * from the revert endpoint) was silently treated as success. The lingering
 * un-reverted batch then resurfaces as a cross-session duplicate once its
 * chunk is re-driven, bouncing adoption toward another hop instead of the
 * one reconcile pass the old comment promised — worst case, riding the
 * MAX_SESSION_ADOPTION_HOPS ceiling to a hard stop with no clear reason
 * why. Fixed: every revert's `response.ok` is checked explicitly.
 *
 * Round-10 audit BLOCK 2, corrected again: the round-8 fix above then
 * ABORTED THE WHOLE ADOPTION the instant ANY revert failed — every
 * confirmed chunk stayed "confirmed" (reset happened only on UNANIMOUS
 * success), and a revert that had already succeeded (this attempt, or an
 * earlier one) counted the SAME as a genuine failure whenever the batch
 * was already reverted: revertImportBatch's own idempotent "already
 * reverted" outcome (P0001, surfaced as HTTP 409 code "not_completed" by
 * the revert route) was treated as failure rather than as the desired end
 * state already being reached. On retry, that already-cleaned batch would
 * 409 again, forever, and because reset was all-or-nothing, a SINGLE
 * durably-failing sibling batch could permanently poison every other
 * chunk's cleanup too, even ones that succeeded on the very first attempt.
 * Fixed to be idempotent and PER-BATCH: a revert response of either
 * response.ok OR the "not_completed"/already-reverted 409 counts as this
 * chunk's cleanup succeeding — both reach the same desired end state, the
 * batch no longer live. Each chunk's OWN outcome decides whether IT resets
 * to "pending", independent of whether any OTHER chunk's cleanup succeeded
 * or failed — a single durably-failing sibling can no longer poison every
 * other chunk's already-successful cleanup the way the round-8 all-or-
 * nothing reset did.
 *
 * NIT, corrected round-11: an earlier version of this comment claimed a
 * chunk resets "even while a sibling's cleanup is still outstanding" —
 * that overstates the concurrency. All per-chunk revert calls are issued
 * together (`Promise.all`, below), but `cleanedIndexes`/`reconciledUpload`
 * are built, and onProgress is called, only AFTER every one of them has
 * settled — so by the time any chunk is actually reset to "pending" and
 * reported, no sibling's cleanup call is still in flight; every sibling's
 * outcome (success, idempotent-already-reverted, genuine failure, or
 * network-ambiguous) is already known. The sequencing is data-safe either
 * way — this only corrects what the comment claimed about ordering, not
 * the fix's actual behavior, which was always PER-BATCH independent
 * outcomes reported together, once, after the batch of cleanup calls
 * settles. A network-level failure (the `fetch` itself throwing —
 * genuinely ambiguous whether the revert committed) is never assumed to
 * have failed OR succeeded: it's simply left "confirmed" for a later
 * attempt, whose own revert call is itself the re-read — a commit that
 * landed resolves as the idempotent already-reverted success above, and
 * one that didn't simply reverts for
 * real. */
export async function confirmChunkedSessionWithResume(
  params: ConfirmChunkedSessionParams,
  depth = 0,
): Promise<ConfirmChunkedSessionWithResumeResult> {
  let latestUpload = params.initialUpload;
  const result = await confirmChunkedSession({
    ...params,
    onProgress: (upload) => {
      latestUpload = upload;
      params.onProgress(upload);
    },
  });

  if (result.ok) return { ok: true };

  if (result.conflictingSessionId && depth < MAX_SESSION_ADOPTION_HOPS) {
    try {
      const check = await fetch(`/api/import/sessions/${result.conflictingSessionId}`, { cache: "no-store" });
      const progress = check.ok
        ? ((await check.json()) as { status?: string; sourceSha256?: string | null })
        : null;
      if (
        progress?.status === "in_progress" &&
        progress.sourceSha256 != null &&
        progress.sourceSha256 === params.plan.sourceSha256
      ) {
        // Round-7 audit finding 3: reconcile-before-adopt. Revert every
        // chunk confirmed under the session about to be abandoned — see
        // this function's own comment above for the apply-timing
        // verification that makes this always safe.
        const confirmedUnderAbandonedSession = latestUpload.filter(
          (c) => c.status === "confirmed" && c.batchId,
        );
        // Round-10 audit BLOCK 2: idempotent, PER-BATCH cleanup — see this
        // function's own comment above for the full reasoning. `cleaned`
        // is true for either a genuine response.ok revert OR the revert
        // route's own idempotent "already reverted" 409 (code
        // "not_completed") — both reach the SAME desired end state, this
        // batch no longer live. A network-level throw is genuinely
        // ambiguous (may or may not have committed) and is never assumed
        // to have succeeded OR failed — reported not-cleaned so this
        // attempt leaves the chunk "confirmed" for a later attempt's own
        // revert call to resolve, one way or the other.
        const cleanupOutcomes = await Promise.all(
          confirmedUnderAbandonedSession.map(async (c) => {
            try {
              const response = await fetch(`/api/import/batches/${c.batchId}/revert`, { method: "POST" });
              if (response.ok) return { index: c.index, cleaned: true };
              const failureBody = await response.json().catch(() => null);
              return { index: c.index, cleaned: failureBody?.error?.code === "not_completed" };
            } catch {
              return { index: c.index, cleaned: false };
            }
          }),
        );
        const cleanedIndexes = new Set(cleanupOutcomes.filter((o) => o.cleaned).map((o) => o.index));

        // Every chunk whose cleanup succeeded (this attempt or a previous
        // one it already resolved) is reset to "pending" right away, never
        // re-attempted again — regardless of whether OTHER chunks are
        // still outstanding. Everything else (already "skipped", never
        // confirmed at all, or still outstanding) is carried forward as-is.
        const reconciledUpload: ChunkUploadState[] = latestUpload.map((c) =>
          cleanedIndexes.has(c.index)
            ? { index: c.index, status: "pending", batchId: null, error: null, code: null }
            : c,
        );

        const stillOutstanding = confirmedUnderAbandonedSession.filter((c) => !cleanedIndexes.has(c.index));
        if (stillOutstanding.length > 0) {
          // Surface the partial progress immediately, BEFORE returning the
          // error — the operator's next "Retry upload" click re-enters this
          // function from scratch with THIS state as initialUpload, so it
          // only ever re-attempts what is genuinely still outstanding,
          // never the chunks this pass already put away.
          params.onProgress(reconciledUpload);
          return {
            ok: false,
            error: "Couldn't clean up a previous attempt at this import — please retry the upload.",
          };
        }

        writeStoredSession({
          sessionId: result.conflictingSessionId,
          sourceSha256: params.plan.sourceSha256,
          label: params.fileLabel,
        });
        params.onSessionId(result.conflictingSessionId);

        // Retry every reconciled chunk under the now-verified session —
        // never just the "remaining" ones (round-7 finding 3's own fix).
        return confirmChunkedSessionWithResume(
          { ...params, initialUpload: reconciledUpload, existingSessionId: result.conflictingSessionId },
          depth + 1,
        );
      }
    } catch {
      // fall through to the hard stop below
    }
    return {
      ok: false,
      error:
        "A chunk of this file matches content from another import that can't be resumed for this file " +
        "(different source file, or already completed/reverted). Revert that import before re-uploading.",
    };
  }

  return { ok: false, error: result.error };
}
