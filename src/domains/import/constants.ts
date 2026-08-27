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

/** A small set of forgiving synonyms for the two most commonly
 * mislabeled columns. Deliberately not a full column-mapping UI —
 * operators are pointed at the downloadable template instead. */
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
  region: "region",
  country: "country",
  size_ml: "size_ml",
  "size (ml)": "size_ml",
  ml: "size_ml",
  format: "format",
  currency: "currency",
  quantity: "quantity",
  qty: "quantity",
  bottles: "quantity",
  unit_cost: "unit_cost",
  cost: "unit_cost",
  price: "unit_cost",
  "unit cost": "unit_cost",
  bin: "bin",
  location: "bin",
  section: "section",
};

/** Columns a row cannot be validated without. */
export const REQUIRED_HEADERS: readonly CanonicalHeader[] = [
  "producer",
  "name",
  "quantity",
];

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
