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
 * matching wall-clock and threaten the preview/confirm routes' 60s
 * budget at the 5,000-row cap. At concurrency 4, worst-case wall-clock
 * for 3N variant queries is ceil(3N/100/4) waves ≈ 0.75× the OLD
 * sequential time for N single queries — i.e. the variant path is
 * strictly faster than the pre-variant contract for every file size.
 * Kept small so at most 4 trigram scans hit the catalog at once. */
export const LWIN_MATCH_CONCURRENCY = 4;

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
