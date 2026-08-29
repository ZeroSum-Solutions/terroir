// G1-4 — CSV cellar import constants.
//
// Size/row thresholds are the documented boundary for the synchronous
// chunked-apply path this slice ships (see docs/runbooks/csv-import.md
// for the full decision record on why this slice does not wire the
// background_jobs runner from G1-6).

/** Server-side upload cap, enforced before any parsing happens. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

/** Data rows (excluding header) a single import may contain. */
export const MAX_ROWS = 5000;

/** A single CSV cell longer than this is rejected — defense against
 * pathological/hostile files (e.g. a single multi-megabyte "cell"). */
export const MAX_FIELD_LENGTH = 2000;

/** MIME types accepted for upload. Browsers are inconsistent about the
 * exact CSV MIME string, so a small allowlist covers the real world. */
export const ALLOWED_CSV_MIME_TYPES = new Set([
  "text/csv",
  "application/csv",
  "application/vnd.ms-excel",
  "text/plain",
]);

/** Spreadsheet (.xlsx) uploads are converted to CSV before they touch any
 * other part of the import pipeline. An .xlsx is a ZIP archive, so a small
 * upload can legitimately decompress into an enormous sheet — these two caps
 * bound that expansion. They are deliberately much larger than MAX_ROWS: a
 * converted spreadsheet is chunked by exactly the same client-side splitter a
 * large CSV is, so it is allowed to exceed one upload's worth of rows.
 * Cell-level limits (MAX_FIELD_LENGTH and friends) are NOT re-applied here —
 * the CSV parser downstream already owns those rules. */
export const MAX_SPREADSHEET_ROWS = 50_000;
export const MAX_SPREADSHEET_CSV_BYTES = 20 * 1024 * 1024; // 20 MB

/** MIME types browsers report for .xlsx. As with CSV the set is small but
 * inconsistent across browsers and operating systems, and an empty string is
 * accepted because some platforms send no type at all for a drag-and-drop. */
export const ALLOWED_SPREADSHEET_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/octet-stream",
  "application/zip",
]);

/** P3 — target row count for one client- or script-planned upload chunk of
 * a file that exceeds MAX_ROWS. Deliberately smaller than MAX_ROWS (5000):
 * leaves headroom so a plan stays valid even if MAX_ROWS is ever tightened,
 * or a particular chunk's rows happen to be unusually wide in bytes. Shared
 * by scripts/validate-bulk-import.ts (CLI chunk planner) and
 * src/domains/import/csv-splitter.ts (browser auto-split in /import) so the
 * two can never drift on chunk size. */
export const CLIENT_CHUNK_TARGET_ROWS = 4000;

/** Rows applied per apply-chunk API call. Small enough that every call
 * comfortably finishes well inside a normal serverless request budget,
 * regardless of total file size — this is what makes big files
 * resumable without a background worker. */
export const APPLY_CHUNK_SIZE = 100;

/** LWIN trigram-similarity threshold — same default as match_lwin (0007).
 * This is the PREVIEW-time "worth showing as a candidate" bar — more
 * permissive than LWIN_APPLY_MIN_SCORE below on purpose (see its comment). */
export const LWIN_MATCH_THRESHOLD = 0.3;

/** C24 (db audit 2026-08-23) — the confidence bar a LWIN match must clear
 * before apply_import_batch_chunk (0108) will persist it into
 * wines.lwin_id. Matches P2's own stated confidence bar (§6 of the P2
 * identity-spine design) exactly, so the two pieces never disagree on one
 * threshold. A row can be "matched" in the preview UI's sense (score >=
 * LWIN_MATCH_THRESHOLD, 0.3) and still be too low-confidence to write —
 * that's deliberate, not a bug: preview surfaces candidates, apply only
 * commits ones worth trusting. Hardcoded identically in
 * apply_import_batch_chunk_v2's SQL (0108) — PL/pgSQL can't import a TS
 * constant, so the two copies are kept in sync by comment cross-reference. */
export const LWIN_APPLY_MIN_SCORE = 0.6;

/** Rows sent to match_lwin_bulk per RPC call. Keeps the request payload
 * and the per-call planner work bounded even for the largest allowed file.
 *
 * Was 300 — reduced as part of the C07 perf fix (db audit 2026-08-23,
 * see supabase/migrations/0078_match_lwin_trgm_fastpath.sql). Even with
 * that fix's indexed trigram prefilter, a worst-case chunk where every
 * row's producer shares a very common word (e.g. "Domaine", "Chateau")
 * measured ~12s for a 300-row all-common-prefix batch against a
 * ~130,000-row catalog — over the `authenticated` role's 8s
 * statement_timeout. The same worst case measured ~4.4s at 100 rows,
 * comfortably inside budget with margin for a larger production
 * catalog and concurrent load. */
export const LWIN_MATCH_BATCH_SIZE = 100;

/** Concurrent match_lwin_bulk RPC calls in flight (Sol audit 2026-08-27
 * finding 1). Producer-less variant queries (buildLwinQueryVariants)
 * amplify query count up to 3× — sequential chunks would triple the
 * matching wall-clock. At concurrency 4, worst-case wall-clock for 3N
 * variant queries is ceil(3N/100/4) waves of the per-call worst-case time.
 *
 * BLOCK 2 (round 5 fix) — the "≈0.75× the OLD sequential time... strictly
 * faster for every file size" claim this comment used to make was never
 * measured under concurrent load, only asserted from the sequential-call
 * arithmetic. Measured this round (scratchpad benchmark against a
 * synthetic 130,000-row catalog, worst-case all-common-producer-prefix
 * queries, 4× concurrent `Promise.all` vs sequential): concurrency 4
 * delivered a 3.61× wall-clock speedup over sequential (ideal 4×) with
 * only a ~9% per-call latency increase from contention — the concurrency
 * assumption holds qualitatively, at least against that environment.
 * What did NOT hold is the "still fits one request" conclusion: at
 * MAX_ROWS (5,000) fully producer-less, worst case is 150 chunks -> 38
 * waves -> ~167s even taking the historical ~4.4s/100-row figure at face
 * value (0078_match_lwin_trgm_fastpath.sql) — still well over the UX
 * budget (LWIN_MATCH_UX_CEILING_SECONDS, round-10 fix: 120s). See
 * LWIN_MATCH_MAX_QUERIES below for the actual
 * fix (a lower, enforced cap on the TOTAL generated query count — round-7
 * fix, corrected from an earlier version of this cap that only counted
 * producer-less rows — not a concurrency increase this pass had no safe
 * way to validate against the shared production database) and
 * docs/runbooks/csv-import.md for the corrected budget analysis. Kept at 4
 * so at most 4 trigram scans hit the catalog at once — raising it further
 * was considered but not made without a production-scale measurement this
 * pass could not safely perform. */
export const LWIN_MATCH_CONCURRENCY = 4;

/** Round-29 audit, BLOCK 3 — the per-call latency INFLATION measured at
 * LWIN_MATCH_CONCURRENCY (4) by the same round-5 scratchpad benchmark
 * LWIN_MATCH_CONCURRENCY's own comment above documents: a ~9% per-call
 * slowdown from contention vs. running one call in isolation. Pulled into
 * its own constant, rather than left as a number only mentioned in prose,
 * so it has exactly one place to be changed if ever re-measured — see
 * LWIN_MATCH_PER_CALL_SECONDS_AT_CONCURRENCY below, its only consumer. */
export const LWIN_MATCH_CONCURRENCY_LATENCY_INFLATION = 1.09;

/** BLOCK 2 (round 7 fix, Sol round-3 audit finding 2 follow-up) — the
 * worst-case wall-clock measured for ONE match_lwin_bulk RPC call, at
 * LWIN_MATCH_BATCH_SIZE (100) rows, against the worst-case
 * all-common-producer-prefix query shape (0078_match_lwin_trgm_fastpath.sql's
 * own comment). Same ~4.4s figure LWIN_MATCH_BATCH_SIZE's own comment
 * already documents — pulled into its own constant so that comment and the
 * budget derivation below can never state two different numbers for the
 * same measured fact.
 *
 * Round-29 audit, BLOCK 3 — PROVENANCE, CORRECTED: this is an INHERITED
 * estimate, not a reproduced one. LWIN_MATCH_CONCURRENCY's own comment
 * above documents a round-5 scratchpad benchmark that re-measured this
 * same worst-case query shape under concurrent load — but against a
 * DIFFERENT synthetic catalog (130,000 rows) on different hardware than
 * whatever produced this 4.4s figure at 0078's original migration time,
 * and that round-5 benchmark came back with a DIFFERENT absolute per-call
 * time of its own, not 4.4s — it could NOT independently reproduce this
 * number. What it DID confirm is the RELATIVE behavior at concurrency 4:
 * a 3.61× wall-clock speedup vs. sequential, and the ~9% per-call latency
 * inflation captured in LWIN_MATCH_CONCURRENCY_LATENCY_INFLATION above —
 * both scale-invariant ratios, unlike the absolute 4.4s baseline they were
 * measured against. This constant is kept as the best available
 * single-call baseline (0078's own worst-case measurement, the one closest
 * to a real production catalog scale), but the query budget below no
 * longer solves for it un-inflated — see
 * LWIN_MATCH_PER_CALL_SECONDS_AT_CONCURRENCY, which applies the measured
 * contention inflation on top of it. */
export const LWIN_MATCH_PER_CALL_SECONDS = 4.4;

/** Round-29 audit, BLOCK 3 — the per-call time that actually applies once
 * LWIN_MATCH_CONCURRENCY (4) calls are in flight together, not the
 * single-call figure above. The query budget below solves for THIS
 * number: using the un-inflated single-call time understated real
 * wall-clock at the configured concurrency and let the old cap authorize
 * a plan that measured out to ~62.3s — over LWIN_MATCH_UX_CEILING_SECONDS
 * (60). See LWIN_MATCH_MAX_QUERIES' own comment for the corrected
 * arithmetic. */
export const LWIN_MATCH_PER_CALL_SECONDS_AT_CONCURRENCY =
  LWIN_MATCH_PER_CALL_SECONDS * LWIN_MATCH_CONCURRENCY_LATENCY_INFLATION;

/** BLOCK 2 (round 7 fix) — the UX-latency ceiling the query budget below is
 * solved for: how long an operator should ever have to watch a spinner for
 * LWIN matching, previewing or confirming ONE import unit (a whole small
 * file, or one auto-split chunk of a larger one). This is the preview/
 * confirm routes' own documented target (see CLEANUP_BUDGET_FROM_ENTRY_MS's
 * own comment for why `maxDuration` itself is inert on this app's Railway
 * deployment and the real ceiling is a UX one, not a platform one).
 *
 * Round-10 fix — RAISED from 60 to 120: 60 was inherited from the routes'
 * (now-confirmed-inert) `maxDuration = 60` metadata, not derived from any
 * real constraint — and once LWIN_MATCH_MAX_QUERIES' own arithmetic was
 * corrected (round-29 audit) to use the concurrency-inflated per-call time,
 * 60s could no longer authorize even a plain MAX_ROWS (5,000) file where
 * every row carries a producer (1 query/row = 5,000 queries), the single
 * most common large-import shape. That is a capability regression, not a
 * safety win, and the 60s number had no platform basis to defend it.
 *
 * Chosen instead by solving forward from two real constraints: (1) the
 * documented capability the product actually offers — MAX_ROWS (5,000)
 * rows — should pass with REAL margin, not sit right at the boundary, so
 * the target is a query capacity of at least 2 x MAX_ROWS (10,000) —
 * enough for the pure producer-bearing case (5,000 queries, 2x headroom)
 * AND a meaningfully mixed file (e.g. up to 2,500 producer-less rows at
 * the 3x variant fan-out, still exactly 10,000); (2) the ceiling must stay
 * comfortably inside Railway's real, documented constraint — its HTTP
 * proxy's ~5-minute (300s) no-data timeout, not the inert `maxDuration`.
 * Solving `floor(ceiling / LWIN_MATCH_PER_CALL_SECONDS_AT_CONCURRENCY) *
 * LWIN_MATCH_CONCURRENCY * LWIN_MATCH_BATCH_SIZE >= 10,000` for `ceiling`
 * needs `floor(ceiling / 4.796) >= 25`, i.e. `ceiling >= 25 * 4.796 ≈
 * 119.9s`. 120s (2 minutes) is the clean round number just above that —
 * only 40% of Railway's 300s timeout, leaving 60% (180s) of margin for
 * response marshaling, network overhead, and the rest of the request
 * lifecycle beyond the matching phase itself. The operator now sees a
 * live wait estimate before the wait begins (estimateChunkedPhaseWaitSeconds,
 * session-step.tsx) — a longer bounded wait with an honest estimate is a
 * fair trade for not rejecting the product's own documented capability. */
export const LWIN_MATCH_UX_CEILING_SECONDS = 120;

/** BLOCK 2 (round 7 fix) — the maximum number of match_lwin_bulk QUERIES
 * (not rows) a single preview/confirm unit may generate, derived — not
 * merely asserted — from the same chain docs/runbooks/csv-import.md
 * documents: queries -> RPC calls at LWIN_MATCH_BATCH_SIZE -> waves at
 * LWIN_MATCH_CONCURRENCY -> seconds at
 * LWIN_MATCH_PER_CALL_SECONDS_AT_CONCURRENCY, solved for
 * LWIN_MATCH_UX_CEILING_SECONDS.
 *
 * Round-7 audit finding: a producer-BEARING row generates exactly 1 query;
 * a producer-LESS row generates up to 3 (buildLwinQueryVariants,
 * lwin-matching.ts) — so the TOTAL query count one preview/confirm unit can
 * generate is `validRows + 2 * producerLessRows`, never just the
 * producer-less subset alone. The prior version of this budget
 * (PRODUCER_LESS_MAX_ROWS, 1,500) counted only producer-less rows — a valid
 * 5,000-row upload with 1,500 producer-less rows and 3,500 producer-bearing
 * ones still generated up to 3,500 + 3·1,500 = 8,000 queries (80 RPC calls,
 * 20 waves at concurrency 4, well over this ceiling either way), because
 * the old cap never looked at the producer-bearing rows' own queries at
 * all.
 *
 * Round-29 audit, BLOCK 3 — INTERNALLY INCONSISTENT ARITHMETIC, CORRECTED:
 * the round-7 version of this derivation solved
 * `floor(LWIN_MATCH_UX_CEILING_SECONDS / LWIN_MATCH_PER_CALL_SECONDS)` =
 * `floor(60 / 4.4)` = 13 waves -> `13 * 4 * 100` = 5,200 queries — using the
 * single-call 4.4s figure directly, while LWIN_MATCH_CONCURRENCY's own
 * comment (above) records a ~9% per-call latency INCREASE from contention
 * at that same concurrency. 13 waves at the actually-applicable per-call
 * time (4.4 * 1.09 ≈ 4.796s) is 13 * 4.796 ≈ 62.3s — over
 * LWIN_MATCH_UX_CEILING_SECONDS (60), contradicting the very ceiling this
 * cap exists to enforce. Recomputed against
 * LWIN_MATCH_PER_CALL_SECONDS_AT_CONCURRENCY — the single source of truth
 * for both this budget and LWIN_MATCH_CONCURRENCY's own contention note —
 * instead: `floor(60 / 4.796)` = 12 waves -> `12 * 4 * 100` = 4,800 queries
 * max. 12 waves at ≈4.796s/wave ≈ 57.6s, inside the then-60s budget with
 * margin; the excluded 13th wave would be ≈62.3s, over it — exactly the
 * boundary `floor` exists to enforce.
 *
 * Round-10 fix — RECONCILED against the product's documented capability:
 * the 4,800 figure above is arithmetically correct for a 60s ceiling, but
 * it exposed a genuine contradiction — a plain MAX_ROWS (5,000) file where
 * every row carries a producer generates exactly 5,000 queries, which
 * EXCEEDS 4,800. The ordinary, most common large import was rejected
 * before any matching ran. The 60s ceiling was never a platform limit (it
 * was inherited from the routes' inert `maxDuration` metadata — see
 * LWIN_MATCH_UX_CEILING_SECONDS' own comment) and had no basis to
 * override the product's own stated row limit, so the ceiling moved
 * instead of MAX_ROWS: with LWIN_MATCH_UX_CEILING_SECONDS now 120,
 * `floor(120 / 4.796)` = 25 waves -> `25 * 4 * 100` = **10,000 queries
 * max**. 25 waves at ≈4.796s/wave ≈ 119.9s, inside the 120s budget; the
 * excluded 26th wave would be ≈124.7s, correctly over it. 10,000 gives a
 * plain MAX_ROWS all-producer-bearing file (5,000 queries) 2x headroom,
 * and still correctly rejects the producer-less worst case at MAX_ROWS
 * (5,000 rows x up to 3 queries each = 15,000 > 10,000) — the budget still
 * does its job of preventing a genuinely unbounded wait, it just no
 * longer rejects the product's own documented capability to do so.
 *
 * enforceLwinMatchQueryBudget (preview-service.ts) checks the file/chunk's
 * ACTUAL generated query count (buildLwinQueryVariants already run, before
 * matchLwinBulk's first RPC call) against this number — the real count, not
 * a worst-case estimate, so a file that happens to have shorter
 * producer-less names (fewer than the worst-case 3 variants each) is never
 * rejected more conservatively than its real query cost warrants. Both
 * buildImportPreview call sites (the preview route, and confirm's own
 * re-derivation — see confirmImportBatch's header) share this one function
 * and one cap.
 *
 * WARN 5 (round-29 audit) — CORRECTED: the claim that used to sit here,
 * "a file can never pass preview and then fail confirm (or vice versa) on
 * this budget," is FALSE whenever row overrides are involved. The preview
 * route calls buildImportPreview with no rowOverrides at all (there is
 * nothing to override yet — this IS the first look at the file); confirm
 * calls it with the operator's overrides applied (confirmImportBatch's own
 * header). A row this function counts as "error" (missing/invalid
 * required field) is filtered out of lwinQueries entirely — it contributes
 * ZERO queries at preview. If an override fixes exactly the field that was
 * failing, the SAME row counts as valid at confirm and contributes up to 3
 * queries (producer-less) or 1 (producer-bearing) — a query count that did
 * not exist when preview computed its own total against this same cap. A
 * file sitting just under the cap at preview, with enough producer-less
 * error rows subsequently fixed, can therefore legitimately EXCEED it only
 * at confirm — preview and confirm share one cap, but not one input, so
 * they are not guaranteed to share one verdict. See buildImportPreview's
 * own budget-check comment (preview-service.ts) for how confirm's error
 * message states this honestly when it happens, rather than leaving the
 * operator to wonder why an already-previewed file suddenly failed. */
const LWIN_MATCH_MAX_WAVES = Math.floor(LWIN_MATCH_UX_CEILING_SECONDS / LWIN_MATCH_PER_CALL_SECONDS_AT_CONCURRENCY);
export const LWIN_MATCH_MAX_QUERIES = LWIN_MATCH_MAX_WAVES * LWIN_MATCH_CONCURRENCY * LWIN_MATCH_BATCH_SIZE;

/** Round-11 fix (WARN 2, round-11 audit) — the multiple of MAX_ROWS
 * LWIN_MATCH_UX_CEILING_SECONDS' own derivation above already solves for
 * ("a query capacity of at least 2 x MAX_ROWS"). Until now that "2x" was
 * only prose: MAX_ROWS is assigned independently near the top of this file,
 * LWIN_MATCH_UX_CEILING_SECONDS is assigned independently above, and
 * nothing actually related the two at runtime — raising MAX_ROWS later (or
 * changing any input the query budget is solved from) could silently
 * recreate exactly the "the product's own documented capability gets
 * rejected before any LWIN RPC call runs" contradiction round-10 fixed, and
 * the "MAX_ROWS regression test" (preview-service.test.ts) wouldn't catch
 * it, since it hardcoded 5,000/10,000 rather than reading these constants.
 * Pulled into its own named constant, and CHECKED below, so the
 * relationship is enforced rather than merely described. */
export const LWIN_MATCH_MAX_QUERIES_MAX_ROWS_MULTIPLE = 2;

/** Fails loudly at module load — not silently at some later request — if
 * the query budget ever stops covering LWIN_MATCH_MAX_QUERIES_MAX_ROWS_MULTIPLE
 * x MAX_ROWS. This is the actual guarantee the round-10 fix exists to
 * provide (a plain, all-producer-bearing MAX_ROWS file passes with real
 * headroom, not right at the boundary); enforcing it here means a future
 * change to any of MAX_ROWS, LWIN_MATCH_UX_CEILING_SECONDS,
 * LWIN_MATCH_PER_CALL_SECONDS(_AT_CONCURRENCY), LWIN_MATCH_CONCURRENCY, or
 * LWIN_MATCH_BATCH_SIZE that breaks the relationship is caught at build/test
 * time (every test importing this module fails), not discovered later as a
 * silently-reintroduced capability regression. */
if (LWIN_MATCH_MAX_QUERIES < LWIN_MATCH_MAX_QUERIES_MAX_ROWS_MULTIPLE * MAX_ROWS) {
  throw new Error(
    `LWIN_MATCH_MAX_QUERIES (${LWIN_MATCH_MAX_QUERIES}) no longer covers ` +
      `${LWIN_MATCH_MAX_QUERIES_MAX_ROWS_MULTIPLE} x MAX_ROWS (${MAX_ROWS} -> ` +
      `${LWIN_MATCH_MAX_QUERIES_MAX_ROWS_MULTIPLE * MAX_ROWS}). Raise LWIN_MATCH_UX_CEILING_SECONDS (or ` +
      `another query-budget input) so a plain, all-producer-bearing MAX_ROWS file keeps passing with headroom — ` +
      `see this constant's own comment and docs/runbooks/csv-import.md.`,
  );
}

/** Canonical CSV column names, in the order the downloadable template uses. */
export const CANONICAL_HEADERS = [
  "producer",
  "name",
  "vintage",
  "varietal",
  "region",
  "country",
  "size_ml",
  "format",
  "currency",
  "quantity",
  "unit_cost",
  "bin",
  "section",
] as const;

export type CanonicalHeader = (typeof CANONICAL_HEADERS)[number];

/** Forgiving synonyms for commonly mislabeled columns — grown from the
 * template's own names to the labels real spreadsheet exports actually
 * use (first real partner export, 2026-08-27: "Wine Name" / "Volume" /
 * "Cost Price"). Still deliberately not a full column-mapping UI.
 * "total cost price" / "total cost" are NEVER mapped: they're derived
 * (unit x quantity) columns, and importing one as unit_cost would
 * multiply every cost by its quantity. */
export const HEADER_SYNONYMS: Record<string, CanonicalHeader> = {
  producer: "producer",
  winery: "producer",
  vineyard: "producer",
  name: "name",
  wine: "name",
  "wine name": "name",
  vintage: "vintage",
  year: "vintage",
  varietal: "varietal",
  variety: "varietal",
  grape: "varietal",
  grapes: "varietal",
  "grape variety": "varietal",
  region: "region",
  appellation: "region",
  country: "country",
  size_ml: "size_ml",
  "size (ml)": "size_ml",
  ml: "size_ml",
  volume: "size_ml",
  size: "size_ml",
  "bottle size": "size_ml",
  format: "format",
  currency: "currency",
  quantity: "quantity",
  qty: "quantity",
  bottles: "quantity",
  unit_cost: "unit_cost",
  cost: "unit_cost",
  price: "unit_cost",
  "unit cost": "unit_cost",
  "cost price": "unit_cost",
  "unit price": "unit_cost",
  "price per bottle": "unit_cost",
  bin: "bin",
  location: "bin",
  section: "section",
};

/** Columns a row cannot be validated without. Producer is NOT required
 * (2026-08-27): real-world exports routinely carry one "Wine Name"
 * column with the producer embedded in it. Such rows persist
 * producer = "" (empty string, never null — wines.producer is NOT NULL,
 * 0002, and apply inserts raw->>'producer' verbatim, 0108). */
export const REQUIRED_HEADERS: readonly CanonicalHeader[] = [
  "name",
  "quantity",
];

/** Unambiguous currency symbols a cost cell may carry ("€45.00"). Used
 * to infer the row currency ONLY when no explicit currency column value
 * is present. "$" is deliberately absent — USD/CAD/AUD all use it, so a
 * $-priced row keeps a null currency (the platform default). */
export const CURRENCY_SYMBOL_TO_CODE: Record<string, string> = {
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
};

// ── C18 (db audit 2026-08-23) ───────────────────────────────────────────
// Number.parseInt/parseFloat accept a numeric PREFIX and silently ignore
// trailing garbage ('2015abc' -> 2015, '750ml' -> 750, '12.5.7' -> 12.50).
// row-validator.ts tests every numeric field against these whole-string
// literal patterns BEFORE calling parseInt/parseFloat — reused verbatim
// from P1's own oracle (scripts/validate-bulk-import.ts), which
// independently defined the same patterns for the same reason, so the two
// tools can never disagree about what counts as "a real number."
export const INTEGER_LITERAL = /^[+-]?\d+$/;
export const FLOAT_LITERAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** C18: quantity/unit_cost had no upper bound at either layer. Matches the
 * DB CHECK constraints added in 0111 exactly. */
export const MAX_QUANTITY = 100_000;
export const MAX_UNIT_COST = 1_000_000;

/** Upper bound for a bottle size in ml (Sol audit 2026-08-27, finding 3).
 * 100L sits far above the largest real formats (a 30L Midas) yet far
 * below both Number.MAX_SAFE_INTEGER precision loss and the int4 range
 * of wines.size_ml — without it, oversized digit strings were silently
 * rounded by parseInt or failed only later at apply's ::int cast. */
export const MAX_BOTTLE_SIZE_ML = 100_000;

/** C18: currency accepted arbitrary free text. A small closed set of
 * ISO-4217 codes actually relevant to a wine cellar — not a full ISO-4217
 * library (YAGNI). Matches the DB CHECK constraint added in 0111 exactly. */
export const ALLOWED_CURRENCIES = new Set([
  "USD",
  "EUR",
  "GBP",
  "CAD",
  "AUD",
  "CHF",
  "JPY",
]);

/** C16 (db audit 2026-08-23) — a permanently-failing row (e.g. a numeric
 * field overflow) was re-selected by every apply_import_batch_chunk call
 * forever, starving every eligible row behind it. After this many failed
 * attempts, apply_import_batch_chunk_v2 (0108) flips the row's resolution
 * to 'pending' so it falls out of eligibility. 3 — chosen because
 * V2-import.md's own repro shows the IDENTICAL failure on every retry with
 * no transient-recovery path, so further retries buy nothing, but the
 * count still tolerates one genuinely transient error before giving up.
 * Hardcoded identically in apply_import_batch_chunk_v2's SQL (0108). */
export const MAX_ROW_APPLY_ATTEMPTS = 3;

/** Sol audit 2026-08-27 round 4 — a soft wall-clock deadline for
 * revertImportBatch's TS-layer cleanup phase (cleanupOrphanWines +
 * clearBatchLwinStamps combined), measured from `revertImportBatch`'s own
 * ENTRY (before the applied-rows snapshot read, before the
 * `revert_import_batch` RPC call — see revertImportBatch's header for why
 * those two steps are never subject to this deadline at all), not from
 * after the RPC returns. Round 3's version started the clock post-RPC,
 * which left the snapshot read (paginated, unbounded per-page count) and
 * the RPC itself completely outside the budget's accounting — a slow
 * snapshot read alone could already have consumed most of the route's 30s
 * before cleanup's own clock even started. Checked before every network
 * request the cleanup phase issues — each `.in()` chunk of a candidate
 * lookup, each table×chunk request of the reference sweep, each query of
 * the per-candidate re-check, and immediately before each DELETE/UPDATE —
 * not merely once per per-candidate iteration.
 *
 * WHAT 20,000ms IS ACTUALLY BOUNDING (Sol audit 2026-08-27 round 5,
 * finding 4 — re-justified; the number is unchanged, the reasoning was
 * wrong): this budget is NOT primarily defending against the revert
 * route's `maxDuration = 30` hard-failing mid-request. That export is
 * Next.js/Vercel-serverless metadata; this app deploys on Railway
 * (`railway.toml`, plain `pnpm start` — a long-running Node process, not
 * a per-invocation serverless function), where `maxDuration` is inert —
 * Railway's own HTTP proxy timeout is measured in minutes, not seconds,
 * so a revert route that ran for, say, 90s would not be killed by the
 * platform at all. The real thing this budget prevents is a UX failure:
 * an operator who clicked "Revert this import" staring at a spinner for
 * however long best-effort cleanup takes on a 5,000-row batch, with
 * nothing to show for it if the browser or an intermediate proxy times
 * the request out first. 20,000ms is chosen as a reasonable UX-latency
 * ceiling for a background cleanup step riding along on a user-initiated
 * action — comparable in shape to the reasoning behind
 * `revert_import_batch` itself being a synchronous RPC rather than a
 * queued job — not derived from `maxDuration`'s 30,000ms at all anymore.
 * The arithmetic below is kept as a sanity check against a THEORETICAL
 * 30s ceiling (the number this repo would need if it ever did deploy
 * behind a real serverless timeout), not as this budget's actual
 * justification: snapshot read + RPC worst case ≈ 7,000ms (the snapshot
 * read pages at 1,000 rows/request; a 5,000-row batch, MAX_ROWS, needs up
 * to SIX sequential requests, not five — PostgREST's page-based
 * pagination only knows a page is the last one when it comes back SHORT
 * of the 1,000-row cap, so a batch whose row count is an exact multiple
 * of 1,000 always needs one extra, empty request to discover the end;
 * `revert_import_batch` itself is one more transaction on top of that).
 * Response margin ≈ 3,000ms (the last in-flight request finishing after
 * the deadline fires, JSON marshaling, network/PostgREST overhead) is
 * reserved at the other end. 30,000 − 7,000 − 3,000 = 20,000 — the same
 * number this constant already used, kept as-is because nothing about
 * correcting the select count or the platform story argues for a
 * different one; it remains a reasonable UX ceiling regardless of which
 * platform enforces (or doesn't enforce) a hard cutoff around it.
 * Exceeding it never fails the revert — it stops issuing any further
 * cleanup request, reports the accurate partial counts already earned,
 * and flags `cleanupTruncated: true` so the operator knows to re-run
 * cleanup later (see docs/runbooks/csv-import.md). */
export const CLEANUP_BUDGET_FROM_ENTRY_MS = 20_000;
