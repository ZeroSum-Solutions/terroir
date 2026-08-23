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

/** Rows applied per apply-chunk API call. Small enough that every call
 * comfortably finishes well inside a normal serverless request budget,
 * regardless of total file size — this is what makes big files
 * resumable without a background worker. */
export const APPLY_CHUNK_SIZE = 100;

/** LWIN trigram-similarity threshold — same default as match_lwin (0007). */
export const LWIN_MATCH_THRESHOLD = 0.3;

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
