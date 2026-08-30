// The operator-facing wait estimate for one phase (preview OR confirm) of
// a chunked import, and the plain-language rendering of it.
//
// estimateChunkedPhaseWaitSeconds is extracted verbatim from
// session-step.tsx; formatRoughDuration/describeWaitEstimate verbatim from
// import-client.tsx. Kept together because the two halves are one
// statement — a number and the sentence that states it honestly — and
// drifting them apart is exactly how the "worst-case bound" overclaim in
// the comments below crept in the first time.

import { LWIN_MATCH_UX_CEILING_SECONDS } from "./constants";

/** WARN 4 (round-29 audit) — LWIN_MATCH_MAX_QUERIES (constants.ts) is
 * SOLVED so each INDIVIDUAL chunk's own LWIN-matching is TARGETED to
 * complete within LWIN_MATCH_UX_CEILING_SECONDS (round-10 fix: 120s), but
 * a multi-chunk file is previewed — and later confirmed — one chunk at a
 * time, sequentially (the loops in planChunkedPreview and
 * confirmChunkedSession above), never in parallel. Every chunk passing its
 * own per-chunk budget says nothing about the TOTAL wait for the whole
 * operation: a 5-chunk file can cost up to roughly 5 x 120s = 600s of
 * preview, then roughly another 600s to confirm.
 *
 * NIT 4 (round-13 fix) — CORRECTED wording: this used to call itself a
 * "wall-clock bound" and "the honest worst-case total," which overstates
 * what LWIN_MATCH_UX_CEILING_SECONDS actually is. It's an INHERITED
 * estimate the query budget is solved against (see
 * LWIN_MATCH_PER_CALL_SECONDS' own comment, constants.ts, for the
 * provenance), and matchLwinBulk (lwin-matching.ts) awaits its RPC calls
 * with no elapsed-time deadline of its own — nothing actually enforces
 * LWIN_MATCH_UX_CEILING_SECONDS as a cap on any one chunk, so multiplying
 * it by chunkTotal can't be a bound either. This is an ESTIMATE of the
 * total for ONE phase (preview OR confirm) of a `chunkTotal`-chunk
 * operation, reusing the exact same per-chunk figure every chunk's own
 * budget is already solved against — never a new, separately-tunable
 * number that could drift from it. Surfaced to the operator BEFORE each
 * phase's own wait begins (import-client.tsx's UploadStep/PreviewStep, and
 * SessionStep below) so "every chunk passes" is never silently read as
 * "the whole operation is fast," and describeWaitEstimate (import-
 * client.tsx) states it as the estimate it is, not a guaranteed cap. */
export function estimateChunkedPhaseWaitSeconds(chunkTotal: number): number {
  return chunkTotal * LWIN_MATCH_UX_CEILING_SECONDS;
}

/** WARN 4 (round-29 audit) — plain-language rendering of an ESTIMATED
 * seconds figure (estimateChunkedPhaseWaitSeconds, session-step.tsx) for
 * the operator-facing cost messages below. Minutes past 90s, otherwise
 * seconds — never false precision.
 *
 * NIT 4 (round-13 fix) — CORRECTED wording: this used to call the input "a
 * worst-case bound." It isn't one — see estimateChunkedPhaseWaitSeconds'
 * own comment (session-step.tsx) for why nothing actually enforces it as a
 * cap. This is a measured duration ONLY in the sense that it's derived
 * from a real (if inherited) benchmark, never a guarantee about any one
 * run. */
export function formatRoughDuration(seconds: number): string {
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** Round-11 fix (BLOCK 1) — wording for the operator-facing wait estimate.
 * The old copy ("up to Xs in the worst case") stated more certainty than
 * the numbers behind it actually have: LWIN_MATCH_PER_CALL_SECONDS
 * (constants.ts) is an INHERITED estimate from a different measurement run,
 * not a reproduced one, and matchLwinBulk (lwin-matching.ts) awaits its RPC
 * calls with no elapsed-time deadline of its own, so nothing actually
 * enforces this number as a cap. Worded here as the approximation it is.
 *
 * BLOCK 2 / NIT 4 (round-13 fix) — this used to also carve out "it doesn't
 * include the brief catalog name lookup that runs afterward": preview used
 * to make a SECOND network call (a separate lwin_catalog display-name
 * lookup) after matching, uncounted by this estimate. That lookup is
 * deleted outright — match_lwin_bulk already returns display_name, so
 * matching is genuinely the only network call this estimate needs to
 * cover, and the carve-out is gone with it. */
export function describeWaitEstimate(seconds: number): string {
  return (
    `approximately ${formatRoughDuration(seconds)} for wine-catalog matching — an estimate from measured ` +
    `matching performance, not a guaranteed cap`
  );
}
