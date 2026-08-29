# CSV cellar import (G1-4, chunked at P3)

Bulk cellar onboarding: upload a CSV of existing inventory, preview it with
zero database writes, confirm it as a persisted batch, then apply it in
bounded chunks. See `supabase/migrations/0076_csv_import_batches.sql` for
the original schema, `supabase/migrations/010{2..11}_*.sql` for P3's
additions, and `src/domains/import/*` for the implementation.

## The decision: chunked ingest, not a raised cap or a worker

**Superseded 2026-08-23 (P3, `docs/plans/2026-08-23-p3-chunked-import.md`).**
This section used to say the row cap was "the signal to revisit" and
sketched wiring a `csv_import` job type through `src/lib/jobs/*`
(background_jobs' claim/reclaim machinery, from G1-6) once files routinely
exceeded it. **That did not happen, and it isn't going to**: Devin's own
call was *"I am completely open and happy to process in 4,000 or 5,000 row
chunks. I think that's actually a better idea."* A file larger than
`MAX_ROWS` is no longer a signal to raise the cap or build a worker — it's
a signal to split the file into multiple chunk uploads (P1's
`scripts/validate-bulk-import.ts` emits the chunk files + per-chunk
manifest; see below) and group them under one `import_sessions` row (P3
§3) for progress/resume/revert-as-a-unit. The partner's ~20,050-row file
ships as 5 chunk uploads of ≤5,000 rows each, each applied exactly the way
the app already applies one batch — `apply_import_batch_chunk` in 100-row
sub-chunks via repeated `POST /apply` calls, unchanged by chunking.

**Why this, restated:**

- The Railway worker service (`railway.worker.toml`, from G1-6) is still
  **not deployed anywhere**. Chunking removes the reason to ever build it
  for this feature: every route handler here still only ever touches
  ≤100 rows per call, the same as before P3.
- `MAX_UPLOAD_BYTES` = 5 MB and `MAX_ROWS` = 5,000 data rows
  (`src/domains/import/constants.ts`) **stay exactly as they were** —
  this is the one thing P3's design doc is explicit was NOT reopened.
  Above either limit within one chunk, the upload is rejected outright
  (413 / a preview-time row-count error) rather than silently truncated;
  a file bigger than that is a splitting problem, not a limit-raising one.
- `apply_import_batch_chunk` (0076, `create or replace`d by 0108 for
  C03/C16/C24 — see "Inherited bug fixes" below) still processes
  `APPLY_CHUNK_SIZE = 100` rows per call, each row wrapped in its own
  exception handler — no change from chunking.
- Preview (`buildImportPreview`) still does the same bulk LWIN-matching
  work synchronously, bounded by `LWIN_MATCH_BATCH_SIZE` rows per RPC
  call, per chunk. Producer-less rows now issue up to 3 query variants
  each (`buildLwinQueryVariants`), and `matchLwinBulk` runs chunks at
  `LWIN_MATCH_CONCURRENCY` (4) in flight.
  **Correction (BLOCK 2, round 5 fix) — the "still fits one request with
  more margin than before" claim above was wrong, and has been removed
  from the arithmetic it was based on.** Taking the documented worst-case
  per-call cost at face value (~4.4s/100-query call,
  `0078_match_lwin_trgm_fastpath.sql`), a fully producer-less file at
  `MAX_ROWS` (5,000) issues 15,000 queries -> 150 chunks -> `ceil(150/4)`
  = 38 waves at `LWIN_MATCH_CONCURRENCY` (4) -> **~167s worst-case wall
  clock**, several times over the routes' own 60s design target — not
  "more margin than before." The "≈0.75× the old sequential time"
  arithmetic itself was directionally correct (verified this round: see
  `LWIN_MATCH_CONCURRENCY`'s own comment, `constants.ts`, for a real
  measurement showing concurrency 4 achieves a 3.61× wall-clock speedup
  over sequential with only ~9% per-call slowdown from contention) — the
  error was concluding that a 0.75×-of-a-too-slow-number result is itself
  fast enough, when the un-multiplied baseline (5,000 single-variant
  queries, sequential) was never actually the thing being compared
  against for the 3×-fanned-out case.

  **Corrected again (BLOCK 2, round 7 fix) — the round-5 fix's own cap
  budgeted the wrong quantity.** `buildImportPreview` enforced
  `PRODUCER_LESS_MAX_ROWS` (1,500) against the count of producer-less rows
  ONLY — but a producer-BEARING row still issues one query each, and those
  queries were never counted against anything. A producer-bearing row
  generates exactly 1 query; a producer-less row generates up to 3
  (`buildLwinQueryVariants`) — so the TOTAL query count one preview/confirm
  unit generates is `validRows + 2 * producerLessRows`, not
  `producerLessRows` alone. Concretely: a valid 5,000-row upload with
  1,500 producer-less rows and 3,500 producer-bearing ones passed the old
  cap outright (1,500 is exactly at the limit) while still issuing
  3,500 + 3·1,500 = 8,000 queries -> 80 RPC calls -> `ceil(80/4)` = 20
  waves -> **~88s at the same 4.4s/call estimate** — already well over the
  60s target the cap exists to enforce.

  The actual fix: `buildImportPreview` (`preview-service.ts`) now checks
  the file/chunk's ACTUAL generated query count (`lwinQueries.length` —
  already built, before `matchLwinBulk`'s first RPC call) against
  `LWIN_MATCH_MAX_QUERIES` (`constants.ts`) — one number derived from the
  same chain this section documents: queries -> RPC calls at
  `LWIN_MATCH_BATCH_SIZE` (100) -> waves at `LWIN_MATCH_CONCURRENCY` (4) ->
  seconds at `LWIN_MATCH_PER_CALL_SECONDS_AT_CONCURRENCY`, solved for a 60s
  UX ceiling (`LWIN_MATCH_UX_CEILING_SECONDS`) — **superseded by the
  round-10 fix further below: the ceiling is 120s now, not 60s: see its own
  section for the current number and the derivation that replaced this
  one.** Both `buildImportPreview` call sites (the preview route, and
  confirm's own re-derivation) share this exact function and constant, so a
  file can never pass preview and then fail confirm (or the reverse) on
  this budget — **corrected by WARN 5 below: this is FALSE whenever row
  overrides are involved (a fix applied between preview and confirm can add
  queries preview's own count never saw) — see that section for the actual,
  narrower guarantee.** A file/chunk whose real query count would exceed
  the cap fails fast, before any LWIN RPC call is issued, with a message
  stating the actual generated query count and the remedy (add producer
  data to more rows, or split the file into smaller chunks) — not a
  producer-less-only row count that, on a mixed file, no longer describes
  what actually needs to shrink.

  **Corrected a third time (round-29 audit, BLOCK 3) — the round-7
  arithmetic above was internally inconsistent with `LWIN_MATCH_CONCURRENCY`'s
  own comment.** It solved `floor(60 / 4.4)` = 13 waves -> `13 * 4 * 100` =
  5,200 queries max, using the single-call 4.4s figure directly — but
  `LWIN_MATCH_CONCURRENCY`'s own comment (`constants.ts`) records a ~9%
  per-call latency INCREASE from contention at that same concurrency (the
  same round-5 benchmark this section already cites). 13 waves at the
  actually-applicable per-call time (4.4 × 1.09 ≈ 4.796s) is
  13 × 4.796 ≈ **62.3s — over the 60s ceiling** the cap exists to enforce.
  Recomputed against `LWIN_MATCH_PER_CALL_SECONDS_AT_CONCURRENCY`
  (`constants.ts`, `LWIN_MATCH_PER_CALL_SECONDS × LWIN_MATCH_CONCURRENCY_LATENCY_INFLATION`
  — the single source of truth for both this budget and the concurrency
  comment's own contention note): `floor(60 / 4.796)` = 12 waves ->
  `12 * 4 * 100` = **4,800 queries max**. 12 waves at ≈4.796s/wave ≈ 57.6s,
  inside budget; the excluded 13th wave would be ≈62.3s, correctly over
  it.

  **Also corrected: the `LWIN_MATCH_PER_CALL_SECONDS` (4.4) provenance
  claim.** This is an INHERITED estimate (0078's own migration-time
  measurement), not one the round-5 benchmark reproduced. That benchmark
  ran against a different synthetic catalog (130,000 rows) on different
  hardware and measured a different absolute per-call time of its own —
  what it DID independently confirm is the RELATIVE behavior: a 3.61×
  wall-clock speedup at concurrency 4 (vs. sequential) and the ~9%
  per-call latency inflation this budget now applies. The 4.4s baseline
  itself was never re-measured or reproduced this round or last.

  **Corrected a fourth time (round-10 fix) — the contradiction the round-29
  note above flagged has been resolved, not merely documented.** The
  round-29 note claimed `MAX_ROWS` (5,000) was "no longer guaranteed to
  fit under this budget on its own": a plain 5,000-row file where every
  row carries a producer generates exactly 5,000 queries, which exceeded
  the then-current 4,800-query cap. That is a capability regression, not a
  safety win — the ordinary, most common shape of a large import (every
  row has a producer) was being rejected before any LWIN RPC call ran, and
  the 60s ceiling that produced the 4,800 figure was never a real platform
  limit. Two independent audits this session confirmed `maxDuration` is
  inert on this app's Railway deployment (`railway.toml` runs a
  long-lived `pnpm start` server, not a per-invocation serverless
  function) — Railway's real constraint is its HTTP proxy's ~5-minute
  no-data timeout, which 60s was nowhere near. `LWIN_MATCH_UX_CEILING_SECONDS`
  moved from 60 to 120 (constants.ts has the full derivation): solving for
  a query capacity of at least 2× `MAX_ROWS` (10,000 — enough for the pure
  producer-bearing case with 2x headroom, and for a meaningfully mixed
  file too) needs `floor(ceiling / 4.796) >= 25`, i.e. `ceiling >= 119.9s`
  — 120s is the clean round number just above that, and only 40% of
  Railway's 300s timeout. Recomputed: `floor(120 / 4.796)` = 25 waves ->
  `25 * 4 * 100` = **10,000 queries max**. A plain `MAX_ROWS`
  all-producer-bearing file (5,000 queries) now passes with 2x headroom.
  The producer-less worst case at `MAX_ROWS` (5,000 rows × up to 3 queries
  = 15,000) still correctly exceeds 10,000 and is still rejected — the
  budget still prevents a genuinely unbounded wait, it just no longer
  rejects the product's own documented row-limit capability to do so. The
  operator sees a live wait estimate before either phase's wait begins
  (`estimateChunkedPhaseWaitSeconds`, `session-step.tsx`), which derives
  from this same `LWIN_MATCH_UX_CEILING_SECONDS` — so a longer, honestly
  estimated bounded wait is the trade for not silently rejecting a normal
  file. **Round-11 fix — until then, that estimate only actually reached
  the operator for a chunked (> MAX_ROWS) file, and only once "previewing"
  was already true: a plain file at or under MAX_ROWS got no estimate at
  all, on either phase. `import-client.tsx`'s `countPreviewUnits` now
  computes it for every file (chunked or not) as soon as one is selected —
  before the operator clicks Preview — and `PreviewStep` shows the confirm
  estimate on the plain path too, not only the chunked one. The wording
  also no longer claims more certainty than the numbers support: it's
  stated as an estimate from measured matching performance, not a
  guaranteed cap (`LWIN_MATCH_PER_CALL_SECONDS`' own comment, constants.ts,
  documents it as an INHERITED figure, and `matchLwinBulk` has no
  elapsed-time deadline of its own). At the time of this fix it was also
  scoped to LWIN matching only, since a separate catalogue display-name
  lookup ran after matching and wasn't included — **round-13 fix: that
  lookup is now deleted (see "Preview is a pure function" below), so the
  estimate covers the entirety of what preview/confirm actually do over
  the network; there is no longer anything left to scope it away from.**

  **BLOCK 1 (round-13 fix) — the estimate could still be READ against the
  wrong file.** `countPreviewUnits` resolves asynchronously (it reads the
  whole file), so an operator could click Preview in the window before it
  resolved for the just-selected file, or — worse — read the PREVIOUS
  file's estimate while a newly-selected, larger file's own count was still
  in flight, then commit to it. `import-client.tsx` now tracks an explicit
  `previewUnitsStatus` ("idle" / "pending" / "ready" / "unavailable") that
  is set to "pending" — clearing the stale value — the instant a new file
  is selected, before the async count even starts; the Preview button stays
  disabled for the whole "pending" window on either path.**

  **WARN 5 (round-29 audit) — corrected, not merely noted: "a file can
  never pass preview and then fail confirm on this budget" (stated above)
  is FALSE whenever row overrides are involved.** The preview route calls
  `buildImportPreview` with no `rowOverrides` (there's nothing to override
  yet); confirm calls it with the operator's fixes applied. A row this
  function counts as an error (missing/invalid required field) contributes
  ZERO queries toward the budget — it's filtered out before `lwinQueries`
  is built. If an override fixes exactly the field that was failing, the
  same row counts as valid at confirm and contributes up to 3 queries
  (producer-less) or 1 (producer-bearing) that preview's own count never
  saw. A file sitting just under the cap at preview, with enough
  producer-less error rows fixed by overrides, can therefore legitimately
  EXCEED the cap only at confirm — preview and confirm share one cap, but
  not always one input, so they are not guaranteed to share one verdict
  (`preview-service.test.ts`'s "a row fixed by an override can push a file
  that passed preview over the budget at confirm" proves exactly this: a
  file passing preview just under the cap, then failing confirm once an
  override fixes its one invalid row). Confirm's own error message states
  this explicitly (the row-fix count and the resulting total) rather than
  leaving the operator to wonder why an already-previewed file suddenly
  failed — see `buildImportPreview`'s own budget-check comment
  (`preview-service.ts`).

  **Round-11 fix (WARN 2) — the "2× MAX_ROWS" headroom above was, until
  now, documentation, not an enforced relationship.** `MAX_ROWS` is
  assigned independently near the top of `constants.ts`;
  `LWIN_MATCH_UX_CEILING_SECONDS` is assigned independently further down;
  only `LWIN_MATCH_MAX_QUERIES` was ever derived from the two. Nothing
  stopped a later change to `MAX_ROWS` (or to any of the budget's other
  inputs) from silently recreating the exact contradiction this round-10
  fix reconciles, and the "MAX_ROWS regression test"
  (`preview-service.test.ts`) wouldn't have caught it — it hardcoded
  5,000/10,000 rather than reading these constants. `constants.ts` now
  exports `LWIN_MATCH_MAX_QUERIES_MAX_ROWS_MULTIPLE` (2) and throws at
  module load if `LWIN_MATCH_MAX_QUERIES` ever drops below
  `LWIN_MATCH_MAX_QUERIES_MAX_ROWS_MULTIPLE × MAX_ROWS` — a change that
  breaks the relationship now fails loudly (every test importing the module
  fails) instead of shipping silently. `preview-service.test.ts`'s
  boundary fixtures (the "exactly at the cap," "one over," and "plain
  MAX_ROWS all-producer-bearing" tests) now compute their row/query counts
  from `MAX_ROWS` and `LWIN_MATCH_MAX_QUERIES` directly, rather than
  hardcoding the numbers those constants currently happen to equal.

**What chunking actually needed, that a single-batch design didn't:**
inventory-level duplicate prevention (§1 — effectively unimplemented
before P3, not merely chunk-unsafe), re-upload idempotency
(`import_batches.content_sha256`, §2 — five chunk uploads instead of one
give an operator five independent chances to double-click or retry), and
an `import_sessions` table (§3) grouping N batches for progress/resume/
revert-as-a-unit. See `supabase/migrations/010{2..11}_*.sql` and
`src/domains/import/{dedup-key,session-service}.ts`.

**The one-command path for a real partner CSV, once it arrives:**
`npx tsx scripts/validate-bulk-import.ts path/to/real-partner-file.csv`
validates it AND writes the chunk files + per-chunk manifest
(`<file>.chunks/part-0001.csv` + `.manifest.json`, `<file>.chunks.manifest.json`)
using the exact same splitter the 20k synthetic-fixture test exercises —
upload each chunk (in order) through `POST /api/import/batches` with
`sessionId`/`chunkIndex`/`chunkTotal`/`sourceSha256` from that manifest.

## Inherited bug fixes shipped alongside chunking (P3, db audit 2026-08-23)

Six inherited findings lived in code this piece rewrites regardless of
chunking, so they were fixed here rather than deferred:

- **C03** — `apply_import_batch_chunk` now locks and checks
  `import_batches.status` first (a reverted batch is a hard no-op), and
  `count_import_batch_rows` (0106) replaced the old uncapped `.select()`
  that PostgREST's 1,000-row `max_rows` silently truncated.
- **C09** — `create_import_batch` (0107) wraps the batch insert, the rows
  insert, and tier-2 duplicate flagging in one function call's implicit
  transaction; `import_batches.content_sha256` (0103) makes re-confirming
  byte-identical content a resume pointer, not a second batch.
- **C16** — `apply_attempts`/`last_error_message` (0104): a row failing
  3 times moves to `resolution = 'pending'` instead of starving every
  eligible row behind it forever.
- **C18** — `row-validator.ts` now rejects `'2015abc'`/`'750ml'`/`'12.5.7'`
  style trailing-garbage numeric text outright (a whole-string literal
  check before any `parseInt`/`parseFloat`), and `quantity`/`unit_cost`
  gained upper bounds + a currency allowlist (`constants.ts`, 0111).
- **C24** — `wines.lwin_match_score` (0105): the wines upsert now only
  forwards an LWIN match at score ≥ `LWIN_APPLY_MIN_SCORE` (0.6, matching
  P2's own bar) and prefers whichever match scored higher, regardless of
  arrival order.
- **C-new-1** — `revert_import_batch` (0109) relaxed its guard from
  "status = completed" to "status ≠ reverted": a partially-applied,
  abandoned batch (or one that never got past `created`) can now be
  reverted too — required for `revert_import_session` (0110) to revert a
  multi-chunk session as a unit even when one chunk is stuck mid-flight.

## Preview is a pure function

`buildImportPreview` (`src/domains/import/preview-service.ts`) parses,
validates, and LWIN-matches a CSV with **zero database writes** — the only
network call it makes is the read-only `match_lwin_bulk` RPC (0076). Both
`POST /api/import/preview` (stops there) and `POST /api/import/batches`
(persists the same computation as a batch) call it — the confirm endpoint
always re-derives from the uploaded file itself, never trusts a
client-supplied preview payload.

**NIT 4 (round-13 fix) — this "only network call" claim used to be false.**
Item 2 (per-row LWIN match visibility) had added a SECOND network call
here: `match_lwin_bulk` already returns `display_name` with each winning
candidate (0076's own `match_lwin_bulk` SELECTs it straight from
`lwin_catalog`), but `matchLwinBulk` (`lwin-matching.ts`) was discarding
that field, so a later round bolted on a separate, independently-paginated
`lwin_catalog` lookup to re-fetch a name the RPC had already returned —
paginated because `MAX_ROWS` (5,000) can exceed PostgREST's 1,000-row
`db.max_rows` cap, which meant a `.in(distinctLwinIds)` filter that could
run to roughly 70,000 URL characters at `MAX_ROWS` fully matched, and a
failure mode where a below-the-fold display name silently degraded to
"Catalog entry (name unavailable)" while the row was **still** auto-
approved for application — visibility and approval had quietly drifted
apart. Deleted outright rather than patched: `display_name` now flows
straight through `matchLwinBulk`'s own `LwinMatch` and the best-of-variants
reduction in `buildImportPreview`, so there is nothing left to
re-fetch, and the claim above is now literally true rather than
approximately true. An apply-eligible match with no display identity
(the residual this leaves — `match_lwin_bulk` returning a real `lwin_id`
but a null `display_name`) is now excluded from `buildApprovedLwinRows`
(`import-client.tsx`) and its own `linkingMatchedRows` band, rather than
being shown with a placeholder and auto-approved regardless.

## Reversibility

`revert_import_batch` (0076, guard relaxed by 0109 — C-new-1) deletes
exactly the `inventory_items` rows recorded in
`import_batch_rows.applied_inventory_item_id` for one batch's applied
rows, callable on any batch not already `reverted` (originally
`completed`-only; a partially-applied, abandoned batch can be reverted
too as of P3). The RPC itself never touches wines, never touches another
batch's rows, and never touches inventory that predates the import — see
`src/domains/import/tenant-isolation.test.ts` and
`src/domains/import/p3-live.test.ts` for live-Postgres proofs, including
against a restaurant with pre-existing inventory for the same wine.

**Single-batch reverts get two TypeScript-layer follow-up steps**
(2026-08-27, `revertImportBatch` in `src/domains/import/batch-service.ts`),
both best-effort (a failure is logged and never fails the revert, and a
per-wine failure never discards counts already earned by wines processed
earlier in the same call): `cleanupOrphanWines` deletes wines this
batch's apply created, and `clearBatchLwinStamps` clears
`wines.lwin_id`/`lwin_match_score` stamps this batch's apply left live.
The route response reports both counts, plus `cleanupTruncated` (see
"Cleanup is bounded" below), `orphanCleanupSkipped` (round 4, finding
6 — set when `cleanupOrphanWines` specifically couldn't run because no
service-role client was available; see "Cross-tenant reference checks run
on the service-role client" below), and `cleanupFailures` (round 5,
finding 3 — see "Cleanup failures get their own counter" below).

**Round 4, finding 3, corrected round 5, finding 2, corrected again round
6, finding 2, corrected again round 7, finding 2:** the revert
confirmation dialog (`src/app/(app)/import/import-client.tsx`) states
plainly that revert also deletes wines and clears LWIN links this import
wrote. Round 4's fix still overclaimed in two places the round-5 audit
caught: it framed the wine-catalog (LWIN) clear as "this import's apply
set," a phrase that reads as freshly-written authorship even for the
documented re-affirmed-pre-existing-pair case (see "The unstamp contract"
below), and the round-4 copy included NO mention of that pre-existing-pair
corner at all. Round 5's fix, in turn, still stated the wine deletion
itself unconditionally — "deletes wines this import added that nothing
else in your cellar references" reads as a guarantee, not as the
best-effort, deadline-bounded, skip-on-doubt operation it actually is
(round 6, finding 2 — a test titled "no absolute authorship" was pinning
exactly that absolute wording). Round 6's fix, in turn, still overclaimed:
"anything it cannot confirm is left in place and reported below" is a
completeness guarantee the code doesn't keep — the child-insert race
(`import-client.tsx:862`) can delete a same-moment reference with no flag
at all, since the wine simply looked unreferenced at the moment of the
check (round 7, finding 2). The dialog now says: "Removes the inventory
this import created. Where it can safely confirm it, it also deletes
wines only this import added and clears the wine-catalog (LWIN) links it
wrote — including a link identical to one that existed before the import.
Cleanup is best-effort: it deletes only wines it can confirm are
unreferenced at that moment, and reports what it did below." — a claim
about what the check confirms AT THAT MOMENT, not a promise that nothing
missed gets flagged. The success panel mirrors this in the past tense
with the actual counts: "Removed N inventory row(s) this import created.
Where it could safely confirm it, this also deleted M wine(s) this import
added and cleared K wine-catalog (LWIN) link(s) it wrote — including any
link identical to one that existed before the import (re-running LWIN
matching restores it if needed)," plus every applicable notice
(`orphanCleanupSkipped`, `cleanupTruncated`, `cleanupFailures` — round 5,
finding 3: these now COMPOSE, never an else-if silently dropping one when
more than one flag is set; round 6, finding 3 added a test pinning all
three composed together, not just two at a time), instead of discarding
the response body.

The snapshot read that both steps depend on (`import_batch_rows`, this
batch's applied rows, taken **before** `revert_import_batch` runs) is
itself wrapped in try/catch: it exists to support best-effort cleanup
ONLY, so a failure reading it never blocks the revert RPC itself — the
inventory revert is what the caller actually asked for. On a snapshot
read failure, both cleanup steps are skipped entirely (reported as zero)
and the RPC still runs and its result is still returned.

Both steps rest on one fact, verified against `apply_import_batch_chunk`
(0108) and the `wines_set_updated_at` trigger (0002): one apply-chunk RPC
*call* is one Postgres transaction, so every row it touches in that call
— the wine it upserts AND the `import_batch_rows` row it marks applied —
shares exactly one `now()`. `revertImportBatch` reads the snapshot of
this batch's applied rows (id, `applied_wine_id`, `updated_at`, `lwin_id`,
`lwin_score`) **before** calling `revert_import_batch`, because that RPC
itself sets `updated_at = now()` on every row it reverts — reading after
would destroy the evidence.

- **`cleanupOrphanWines`** deletes a wine only when some snapshot row's
  own `updated_at` exactly equals that wine's `created_at`, AND the wine
  has zero references anywhere else (see "Cross-tenant reference checks"
  below). The timestamp equality holds for every NON-MALICIOUS writer —
  no product code path ever writes `created_at` directly, so this is
  reliable evidence the wine was created in that row's own apply-chunk
  transaction, not a guess about a time window. (This replaces an
  earlier, incorrect `wines.created_at >= batch.created_at` heuristic,
  whose write-up wrongly claimed every product write path that creates a
  wine also creates a referencing row in the same operation; real
  bare-wine paths exist — `src/app/api/cellar/route.ts`,
  `src/app/api/inventory/save-scan/route.ts`, and `src/app/api/wines/
  create-from-lwin/route.ts`, the last of which gets a `wine_list_items`
  reference only from a later, separate user action.) It is deliberately
  NOT treated as proof against a malicious same-tenant writer — see
  "What the timestamp equality does and does not prove" below. Reference
  checks (the 9-table sweep plus other batches' `applied_wine_id` claims)
  run once in bulk against every candidate; then, immediately before each
  wine's own `DELETE`, every non-RESTRICT table among them plus other
  batches' `applied_wine_id` claims (round 5, finding 1, extended round 6,
  generalized round 7 — see "Cross-tenant reference
  checks run on the service-role client" below) are re-checked again,
  single-wine and concurrently, and the `DELETE` itself carries a
  compare-and-swap against the exact timestamp the equality check above
  matched (round 6, finding 1 — see the same section).
- **`clearBatchLwinStamps`** clears a wine's stamp only when, for one of
  this batch's own qualifying rows (score ≥ `LWIN_APPLY_MIN_SCORE`), BOTH
  the wine's current `updated_at` equals that row's own `updated_at` AND
  the wine's current `(lwin_id, lwin_match_score)` equals that row's own
  values. (This replaces an earlier design that trusted a non-null
  `lwin_match_score` to mean "written by a batch apply" — false: `wines`
  RLS grants members unrestricted UPDATE, so any client can pre-write an
  identical pair. The timestamp check closes that hole for a pre-write or
  overwrite happening after this batch's apply and before this revert;
  the exact-pair check is still needed alongside it, since any row that
  merely dedup-matches an existing wine bumps that wine's `updated_at`
  regardless of whether its own LWIN match actually won apply's
  "prefers higher score" upsert logic.) See "The unstamp contract" below
  for exactly what "cleared" means when a wine already carried this pair
  before apply ran.

### What the timestamp equality does and does not prove

(Sol audit 2026-08-27 round 3, finding 1 — replaces an earlier
"provable authorship" framing that overclaimed this.) `cleanupOrphanWines`'
`created_at == snapshot row's updated_at` check is proof against every
NON-MALICIOUS writer: no product code path ever writes `created_at`
directly. It is **not** proof against a malicious one. `wines` RLS grants
members unrestricted UPDATE with no column-level restriction on
`created_at` ("members can update their wines",
`supabase/schema.snapshot.sql`), and `import_batch_rows` is
member-readable ("members can read import batch rows") — so a same-tenant
member could read a snapshot row's `updated_at` and deliberately rewrite
some other, pre-existing bare wine's `created_at` to match it, forging
this guard into deleting that wine.

This is deliberately **not treated as a hole to close**: `wines` RLS also
grants members unrestricted DELETE on their own restaurant's wines
("members can delete their wines") — a member willing to forge
`created_at` already holds the DELETE right directly, so the forgery buys
them nothing they didn't already have. Adding new TS-layer mechanism here
would defend a privilege boundary that doesn't actually move. If a future
audit finds members do NOT hold direct DELETE on wines, this reasoning
would need to be revisited and the guard tightened.

### Cross-tenant reference checks run on the service-role client

(Sol audit 2026-08-27 round 3, finding 3 — the serious one.)
`cleanupOrphanWines`' reference-existence checks (the bulk sweep AND the
fresh pre-delete re-check) run on a **service-role** client, passed into
`revertImportBatch` as a 4th parameter by the revert route
(`src/app/api/import/batches/[id]/revert/route.ts`, via
`createServiceRoleClient()` from `src/lib/supabase/service-role.ts`) —
never on the caller's RLS-scoped client. The snapshot read, the
`revert_import_batch` RPC call, and the wine `DELETE` itself all stay on
the caller's RLS-scoped client (tenant-scoped, so the `DELETE` can never
itself cross tenants).

This is load-bearing, not a style preference: `stock_adjustments`' INSERT
RLS policy ("members insert own stock_adjustments") checks only
`is_member(restaurant_id) and acting_user_id = auth.uid()` — never that
`wine_id` belongs to that same `restaurant_id` — and `wine_id` is `ON
DELETE CASCADE`. So a tenant-B member can insert a `stock_adjustments`
row naming tenant A's `wine_id`. Tenant A's reference sweep, run on A's
own RLS-scoped client, can never see that tenant-B row (RLS hides it) —
and Postgres referential-integrity actions (the cascade) bypass row
security entirely when they fire. Without a service-role sweep, A's wine
`DELETE` would destroy B's row. `bottle_closeouts` has the identical
shape (member insert, `restaurant_id`-only check, `wine_id` cascade —
see the next section). A service-role client sees every tenant's rows,
closing this regardless of which tenant wrote the referencing row.

If the service-role client is unavailable — `SUPABASE_SERVICE_ROLE_KEY`
MISSING; see `src/lib/supabase/service-role.ts` — `cleanupOrphanWines`
skips deletion entirely for that revert (logs and returns zero) rather
than falling back to the RLS-scoped client — falling back would silently
reintroduce the exact risk above. **Round 4, finding 6:** this used to be
silent past a server log — `RevertBatchResult.orphanCleanupSkipped` now
says so explicitly in the revert route's own response, and the client
surfaces it in the revert success message ("Orphan-wine cleanup was
skipped — service configuration missing," corrected round 5, finding 3,
from a vaguer "Catalog cleanup was skipped" that wrongly implied LWIN
unstamping was skipped too). This flag is about `cleanupOrphanWines`
specifically, not `clearBatchLwinStamps` — the LWIN unstamp needs no
service-role client and still runs normally even when this flag is true.
**A PRESENT-but-invalid key is a different case** (round 5, finding 3):
`createServiceRoleClient` only returns `null` for a MISSING key —
`createClient` from `@supabase/supabase-js` does not validate the key
against Supabase, so a present-but-wrong key still constructs a real
client (`orphanCleanupSkipped` stays `false`) and only fails once that
client issues its first real request. That failure is caught by
`cleanupOrphanWines`'s own top-level try/catch in `revertImportBatch` and
counted in `cleanupFailures` instead — see "Cleanup failures get their
own counter" below.
The required env var is documented in `docs/LOCAL-SUPABASE.md`'s
Environment section (`SUPABASE_SERVICE_ROLE_KEY`) for local dev;
`docs/STAGING-SETUP.md` does not enumerate a per-service env-var
checklist, so there is nothing to add there. Live proof:
`src/domains/import/tenant-isolation.test.ts`, "bar 5" — a tenant-B
`stock_adjustments` row naming tenant A's applied wine, seeded through
tenant B's own RLS-scoped client exactly as a real attacker would, must
survive tenant A's revert, and the wine must survive too.

**Round 4, finding 1, corrected round 5, finding 1:** round 4 tried to
narrow the TOCTOU window by ordering the checks inside a single
`findReferencedWineIds` call so `stock_adjustments`/`bottle_closeouts` ran
LAST, immediately before the `DELETE` that follows a re-check. That
design had two bugs the round-5 audit found: (a) it treated the cross-batch
`import_batch_rows` claim, checked FIRST in that same call, as
unforgeable — false: `import_batch_rows` is itself member-insertable and
-updatable with an arbitrary `applied_wine_id` (neither
`import_batch_rows`' INSERT nor UPDATE RLS policy checks that
`applied_wine_id` belongs to the same restaurant, `supabase/
schema.snapshot.sql`), so the real forgeable window for that table was ~9
sequential round-trips under round 4's design, not the "checked first
because it's safe" round 4 assumed; (b) `stock_adjustments` and
`bottle_closeouts` were themselves checked sequentially — one `await`
apart — so even between just those two the claimed "single round-trip"
window was actually two.

The fix: `findForgeableReferencesForWine` (`batch-service.ts`) is a
dedicated final check, separate from the bulk sweep, that re-checks all
THREE forgeable tables — the cross-batch `import_batch_rows` claim,
`stock_adjustments`, `bottle_closeouts` — **concurrently**, via
`Promise.all`, as the last step before the `DELETE`, with no other
`await` in between. The other seven `WINE_REFERENCING_TABLES` tables are
trusted from the bulk sweep (`findReferencedWineIds`) alone and never
re-checked per-candidate — see "Cleanup is bounded" below for why a race
in any of those seven is harmless by construction (RESTRICT-FK failure or
RPC tenant-gating), not merely unlikely, so re-checking them again would
spend a request to prevent an outcome the `DELETE` itself already
prevents safely. This shrinks the residual TOCTOU window to ONE PARALLEL
round-trip for all three forgeable tables, replacing what round 4's
design actually left as up to ~9 sequential round-trips for the worst of
the three. One consequence differs by table, and is worth naming
explicitly: `stock_adjustments`/`bottle_closeouts`' FK is `ON DELETE
CASCADE`, so a forged row that loses this race is destroyed;
`import_batch_rows.applied_wine_id` is `ON DELETE SET NULL`, so a forged
row there that loses the race merely has that column silently nulled —
milder, but named here rather than left unstated. See "Cleanup is
bounded" below for what the narrowed window still allows and why it's
accepted rather than closed outright.

**Round 6, finding 1 — a fourth forgeable table, and a CAS on the
`DELETE`:** `availability_events` (`ON DELETE CASCADE`) was missing from
`findForgeableReferencesForWine` entirely. Unlike the three tables above,
the danger isn't a malicious forgery — `set_wine_availability` is
`SECURITY DEFINER`, derives its own `restaurant_id` from the wine, and
requires an owner/manager of that same restaurant, so there's no RLS gap
to exploit. The danger is that a *legitimate* manager action (toggling a
wine 86'd) landing in this exact window would have its own audit event
cascade-deleted along with the wine. `findForgeableReferencesForWine` now
checks `availability_events` concurrently alongside the other three (four
tables total, still one `Promise.all`). That alone still leaves the same
one-round-trip gap this whole section describes, so `cleanupOrphanWines`'
`DELETE` also gained a compare-and-swap: `.eq("updated_at", <the exact
timestamp the created_at-equality guard matched>)`. Verified against
`supabase/schema.snapshot.sql`: `set_wine_availability` `UPDATE`s `wines`
(setting `is_eightysixed`) BEFORE it `INSERT`s the `availability_events`
row, and `wines_set_updated_at` fires on every `wines` `UPDATE`
unconditionally — so a manager's call bumps `updated_at` strictly before
its own event exists, and the CAS filter (comparing against the
pre-mutation timestamp) matches zero rows, sparing both the wine and the
event it just gained. A zero-row CAS result is a skip, not a failure —
nothing is thrown, the delete count simply isn't incremented. This closes
the gap for any writer whose own INSERT is preceded by a `wines` UPDATE —
today, only `set_wine_availability` — but does nothing for the other
three forgeable tables' own INSERT paths, none of which touch the `wines`
row at all (`stock_adjustments`, `bottle_closeouts`, and
`import_batch_rows` each insert into their own table only); those three
still depend entirely on the concurrent `Promise.all` re-check, unchanged
by the CAS. See "Cleanup is bounded" below for the residual this leaves.

**Round 7, finding 1 — the GENERAL rule, not a fifth special case
(BLOCK):** round 6's fix still framed the re-check as a growing list of
individually-discovered "forgeable tables," which is exactly how it
missed three more `ON DELETE CASCADE` children with the same shape as
`availability_events`: `open_bottles` (inserted by `POST
/api/open-bottles`, `src/app/api/open-bottles/route.ts`, on the
SERVICE-ROLE client, straight after reading inventory — no `wines` write
anywhere in that path) and `cellar_health` / `pricing_recommendations`
(written the same way by their own service-role recompute jobs,
`src/lib/cellar-health/recompute.ts` and
`src/lib/pricing-recommendations/recompute.ts`). None of the three is an
RLS-policy exploit, same as `availability_events` — but a member being
policy-denied from writing them directly does NOT stop these writers,
since all three run on the service role, outside any member RLS check
entirely. **The fix is general, not per-table:** every direct FK onto
`wines(id)` was re-derived from `supabase/schema.snapshot.sql` and
classified by its `ON DELETE` action —
- RESTRICT (self-protecting, bulk-swept only): `inventory_items.wine_id`,
  `wine_list_items.wine_id`, `pour_events.wine_id`.
- CASCADE or SET NULL (re-checked in the final parallel read):
  `availability_events.wine_id`, `open_bottles.wine_id`,
  `cellar_health.wine_id`, `bottle_closeouts.wine_id`,
  `stock_adjustments.wine_id`, `pricing_recommendations.wine_id` (all
  CASCADE), and `import_batch_rows.applied_wine_id` (SET NULL).

`findForgeableReferencesForWine` now re-checks EVERY non-RESTRICT
`WINE_REFERENCING_TABLES` table — six of the nine — plus the separately
queried `import_batch_rows.applied_wine_id` cross-batch claim (seven
concurrent checks) via one
`Promise.all`, still one parallel page-read in the common case. **The two
layers catch different writers:** the final parallel read catches every
non-RESTRICT child's writer, including a service-role/job path that never
touches the wine row at all (`open_bottles`, `cellar_health`,
`pricing_recommendations`, plus the three original RLS-gap tables); the
`DELETE`'s own CAS guard catches only a writer that DOES touch the wine
row first, which today is exclusively `set_wine_availability`. `open_
bottles`, `cellar_health`, and `pricing_recommendations` therefore depend
entirely on the concurrent re-check, exactly as `stock_adjustments`,
`bottle_closeouts`, and the cross-batch `import_batch_rows` claim already
did. See "Cleanup is bounded" below for the residual this leaves.

### The unstamp contract

(Sol audit 2026-08-27 round 3, finding 2.) `clearBatchLwinStamps` clears
the LWIN linkage this batch's apply **left live** on a wine — that is the
contract, and it covers two cases equally: apply's conflict UPDATE either
wrote the `(lwin_id, lwin_match_score)` pair fresh, OR it re-affirmed an
identical pre-existing value. Both count as "left live," and both are
intended behavior, not merely tolerated.

Concretely: when a row's apply-time dedup match hits a wine that already
carries the exact pair this row's own match would also write (a
re-imported file, or a coincidental earlier stamp), `apply_import_batch_
chunk_v2`'s `ON CONFLICT DO UPDATE` still runs — its `CASE` expressions
leave the values unchanged (this row's score doesn't beat the existing
one), but the `UPDATE` statement itself still executes, and
`wines_set_updated_at` still bumps `updated_at` in that row's own
apply-chunk transaction. That transaction genuinely touched the wine and
left exactly this row's own values live, whether or not any byte actually
changed — so `clearBatchLwinStamps` clearing it on revert is correct
under the contract, not a bug. (An earlier "authorship proof" framing of
this same mechanism was FALSE and has been dropped — round 2 already
showed `wines` RLS lets any member pre-write an identical pair, so
"non-null implies apply wrote it" never held; the mechanism itself is
unchanged from round 2, only the claim about what it proves.)

**Recovery path** for the identical-pre-existing-pair corner: if a stamp
gets cleared that some OTHER source (not this batch) actually wanted
live, re-running LWIN matching against the wine restores it — the match
computation is idempotent and does not depend on import history. Live
proof of the contract: `src/domains/import/p3-live.test.ts`, "clears a
stamp apply's conflict UPDATE left live, whether it wrote it fresh or
re-affirmed an identical pre-existing value."

### Cleanup is bounded

(Sol audit 2026-08-27 round 3, finding 5; deadline arithmetic corrected
round 4, finding 2, and re-justified round 5, finding 4.) Batches support
up to 5,000 applied rows (`MAX_ROWS`, `src/domains/import/constants.ts`).
Two bounds keep cleanup's own latency reasonable:

- **Chunked `.in()` queries.** Every reference-existence or wine-lookup
  query built from a candidate-id array chunks the ids to at most 100 per
  request (`IN_CLAUSE_CHUNK_SIZE`, `batch-service.ts`) — at 5,000
  candidates, one unchunked `.in()` could carry ~156,000 characters in a
  single request URL.
- **A soft wall-clock deadline** (`CLEANUP_BUDGET_FROM_ENTRY_MS`,
  20,000ms — renamed round 4 from `CLEANUP_SOFT_BUDGET_MS`; see its own
  comment in `src/domains/import/constants.ts` for the exact arithmetic)
  shared across BOTH cleanup steps combined, and — this is the round-4
  fix — measured from `revertImportBatch`'s own ENTRY, before the
  applied-rows snapshot read and the `revert_import_batch` RPC call,
  neither of which is ever subject to it. Round 3's version started the
  clock only after both had already completed, which left a slow
  snapshot read (paginated, unbounded page count) or a slow RPC call able
  to consume most of the budget before cleanup's own clock even started
  counting. **Round 5, finding 4 — what this budget actually bounds:**
  the revert route's `export const maxDuration = 30` is Next.js/Vercel
  serverless metadata; this app deploys on Railway (`railway.toml`, a
  plain long-running `pnpm start` process, not a per-invocation
  serverless function), where `maxDuration` is inert and Railway's own
  HTTP proxy timeout is measured in minutes. The 20,000ms deadline
  therefore isn't defending against a hard platform cutoff — it's a
  reasonable UX-latency ceiling for a best-effort cleanup step riding
  along on a user-initiated revert click, so an operator isn't left
  staring at a spinner indefinitely. The arithmetic against a
  hypothetical 30s ceiling is kept in the constant's own comment as a
  sanity check, not as the actual justification, and the round-4 select
  count in that arithmetic was off by one: a 5,000-row batch (exactly
  `MAX_ROWS`) needs up to SIX sequential snapshot-read requests, not
  five — PostgREST's page-based pagination only learns a page is the
  last one when it comes back SHORT of the 1,000-row cap, so a row count
  that's an exact multiple of 1,000 always needs one extra, empty request
  to discover the end. The deadline is checked before EVERY request the
  cleanup phase issues — each `.in()` chunk of a candidate lookup, each
  table×chunk request of the reference sweep, each query of the
  per-candidate re-check, and immediately before each `DELETE`/`UPDATE` —
  not merely once per per-candidate loop iteration, which is what let
  round 3's version start a candidate lookup of up to 50 sequential
  requests, or a bulk sweep of up to ~500, with no check anywhere inside
  either. Once the deadline passes, cleanup stops before issuing its next
  request rather than finishing the one already in flight and then
  checking — a bulk reference sweep alone issues ~10 sequential requests
  (9 `WINE_REFERENCING_TABLES` + 1 cross-batch `import_batch_rows`
  check), so at scale that's the dominant cost (the final, per-candidate
  re-check is 7 requests — every non-RESTRICT `WINE_REFERENCING_TABLES`
  table plus the cross-batch `import_batch_rows` claim, round 7, finding
  1 — run concurrently, see "Cross-tenant reference checks run on the
  service-role client" above). **Round 6, finding 5 — this is a per-table
  REQUEST count, not a page count:** each
  of those requests is itself the first page of a `fetchAllRows` loop, so
  "1 parallel round-trip" (or "~10 sequential requests") describes the
  common case only. A table with more than 1,000 rows referencing the
  SAME wine — pathological, but not impossible for a long-lived wine with
  heavy `stock_adjustments`/`pour_events` history — adds one additional
  sequential page request per 1,000 rows past the first, still checked
  against `deadline` before each one and still fail-closed throughout (a
  truncated page read is treated as "still referenced," never as
  "unreferenced by omission"). The counts returned are always exactly
  what genuinely ran — never padded or estimated — and the response
  carries `cleanupTruncated: true` plus a log line so the operator knows
  more candidates were left untouched.

**Re-run path when cleanup is truncated:** re-running revert itself is
not meaningful (the batch is already reverted) — the recovery is the
same as any other cleanup shortfall: a manual cleanup pass, or (for a
truncated LWIN unstamp) re-running LWIN matching against the affected
wines.

**Residuals that remain, honestly, rather than being claimed away:**
(a) two distinct apply-chunk transactions landing on the exact same
microsecond timestamp would be indistinguishable — negligible, accepted;
(b) the reference re-check and the `DELETE` are still separate steps, so
in principle ANY referencing table could receive a fresh, cascade-linked
insert in the gap between them. **The general rule (round 7, finding
1):** EVERY non-RESTRICT `WINE_REFERENCING_TABLES` table — six of the
nine, plus the separately queried `import_batch_rows.applied_wine_id`
cross-batch claim — is covered by the final, per-candidate re-check
(`findForgeableReferencesForWine`); only the three RESTRICT tables are
NOT covered, and for them alone this gap is harmless by construction, not
merely unlikely: `inventory_items`, `wine_list_items`, and `pour_events`
are `ON DELETE RESTRICT`, not CASCADE, so a concurrent insert there makes
the `DELETE` fail outright instead of losing data, caught per-wine and
skipped, never silently pretended to have succeeded.

Two different reasons land a table in the seven that ARE re-checked.
`stock_adjustments` (`src/app/api/stock-adjustments/route.ts`),
`bottle_closeouts` (RLS-insertable directly, even though the app's own
`close_open_bottle` RPC path, `src/app/api/open-bottles/close/route.ts`,
IS tenant-safe and requires a live open bottle), and `import_batch_rows`'
own cross-batch `applied_wine_id` claim are three where the gap is
genuinely forgeable in the RLS-exploit sense — the first two cross-tenant
(neither requires live inventory to write via a direct RLS insert, and
neither's INSERT policy checks that `wine_id` belongs to the inserting
tenant), the third same-tenant-or-cross-tenant (any member can insert or
update an `import_batch_rows` row with an arbitrary `applied_wine_id` —
see "Round 4, finding 1, corrected round 5, finding 1" above).
`availability_events` (round 6, finding 1) and `open_bottles`,
`cellar_health`, `pricing_recommendations` (round 7, finding 1) are the
other four — none has a member-insertable RLS gap (`open_bottles` is
inserted by `POST /api/open-bottles` on the SERVICE-ROLE client;
`cellar_health`/`pricing_recommendations` are written by their own
service-role recompute jobs; `availability_events` only by the SECURITY
DEFINER `set_wine_availability` RPC) — but each IS `ON DELETE CASCADE`,
and the writer that can land in this gap is, in every case, a genuinely
legitimate same-tenant action or background job, not an attacker.
`findForgeableReferencesForWine` (`batch-service.ts`) checks all seven
CONCURRENTLY, immediately before the `DELETE` that follows a re-check,
shrinking this residual to ONE PARALLEL PAGE-READ for all seven in the
common case (round 6, finding 5 — see "Cleanup is bounded" above for why
this is a page-read, not an unqualified round-trip: pathological
reference volumes for a single wine add further sequential pages, still
fail-closed) — a narrowing, not a closure: a forged or legitimate insert
landing in that gap is still possible in principle. What makes the
narrowed residual acceptable differs by table: for
`stock_adjustments`/`bottle_closeouts`, the ONLY way a cross-tenant row
can occupy that window at all is by exploiting the pre-existing gap in
those two tables' own INSERT policies (see the next section) — no
product code path this app ships ever writes a `wine_id` outside its own
tenant, so any row that shows up there naming another tenant's wine is
necessarily a deliberate malicious insert exploiting that policy gap,
never innocent concurrent activity; the forger is the only party who can
lose that row (it's destroyed by the CASCADE), and only by choosing to
exploit a vulnerability that already lets them attach arbitrary rows to a
wine they don't own. For `import_batch_rows`, the same "only a
policy-gap exploit gets a row there" reasoning applies, but losing the
race is strictly milder: `applied_wine_id` is `ON DELETE SET NULL`, not
CASCADE, so a forged row that loses the race has that column silently
nulled, not destroyed. For `availability_events`, the DELETE's own CAS
guard (round 6, finding 1) independently closes the remaining gap for
its actual writer (`set_wine_availability`, since it always touches
`wines` before inserting its event) — the residual there is narrower
still: a `set_wine_availability` call landing specifically inside the
`Promise.all` itself resolving and the DELETE request going out, the
same order of residual as (a) above. For `open_bottles`, `cellar_health`,
and `pricing_recommendations` there is no CAS backstop — none of their
writers touches the `wines` row — so the residual for those three stays
the full single-page-read window, accepted for the same reason as
`availability_events`'s pre-CAS residual: each writer is a legitimate,
same-tenant, non-malicious product code path, not an attacker. The two
fixes that would close the window outright for the three RLS-gap tables —
an ownership `WITH CHECK` on all three tables' write policies (closing
the underlying gaps
directly), or moving the re-check and the `DELETE` into one `SECURITY
INVOKER` RPC transaction (closing the window itself) — are both
migration-gated and out of reach for this TS-layer-only pass; tracked
here until the migration lock lifts, same as the "Known gap" below; (c)
for the LWIN unstamp, a third party writing the
exact `(lwin_id, lwin_match_score)` pair a row's own LWIN match would
independently compute, before apply ran, on a wine that row also
dedup-matches, passes both checks by coincidence — this requires guessing
a specific trigram-similarity float to exact precision ahead of time,
the same order of residual as (a); (d) the snapshot read happens before
`revert_import_batch` runs, but an apply holding the batch's advisory
lock can still commit MORE rows after the snapshot and before the RPC —
revert then reverts rows the snapshot never captured, and their wines/
stamps are never cleaned by this call. This is the conservative
direction (nothing gets wrongly deleted), and a subsequent cleanup pass
against those specific rows is the recovery, same as (a)–(c).

### Cleanup failures get their own counter

(Sol audit 2026-08-27 round 5, finding 3.) Before this round, an
incomplete cleanup often reported as a plain success: the applied-rows
snapshot read failing, either cleanup step's own top-level error, and
every per-candidate delete/update failure were all caught and logged, but
no response flag ever moved to reflect it — an operator reading only the
success panel's counts had no way to tell "0 orphan wines because there
were none" apart from "0 orphan wines because cleanup kept failing."
`RevertBatchResult.cleanupFailures` (propagated through the revert route
and the client) now counts every one of those: the snapshot-read
failure, either cleanup step's own top-level catch (e.g. a service-role
client that constructs fine — `createServiceRoleClient` only returns
`null` for a MISSING key, never an invalid one — but fails on its first
real request), and each function's own per-candidate `failures` count.
It is deliberately independent of `cleanupTruncated` (a
`CleanupDeadlineExceededError` is a soft-budget stop, not a failure, and
is never counted here) and of `orphanCleanupSkipped` (no service client
at all is a config gap, not a request failing). The client surfaces a
"some cleanup steps failed" notice whenever `cleanupFailures > 0`, and —
round 5, finding 3's other fix — that notice, `cleanupTruncated`'s, and
`orphanCleanupSkipped`'s now all COMPOSE (independent `if`s, not an
else-if chain that silently dropped one when more than one applied). The
`orphanCleanupSkipped` notice's own wording was also corrected to name
orphan-wine cleanup specifically ("Orphan-wine cleanup was skipped…"
rather than a vague "Catalog cleanup was skipped…"), since the LWIN
unstamp path needs no service-role client and keeps running normally even
when that flag is true — the old, vague wording wrongly implied it was
skipped too.

Every `wines(id) ON DELETE CASCADE` table was re-checked against
`supabase/schema.snapshot.sql` for this audit round. Besides
`stock_adjustments` and `bottle_closeouts` (both member-insertable
without live inventory, both named above), the only other CASCADE tables
are `open_bottles`, `cellar_health`, and `pricing_recommendations`.
**Correction (round 4, finding 4):** these three do carry a migration-time
`revoke insert, update, delete ... from authenticated` statement, but
migration 0074 (`supabase/schema.snapshot.sql`, "Restore the table
privileges required by Supabase's Data API roles") later
`grant select, insert, update, delete on all tables in schema public to
authenticated, service_role` — a blanket re-grant that runs after every
earlier per-table revoke in migration order, superseding it at the
table-privilege level. The revoke statements are therefore inert today,
not the operative protection; citing them as "no member can write to
them at all" overstated what's actually stopping a write. The ACTUAL
protection verified against the current snapshot: all three tables carry
only a `for select` RLS policy each ("members can read open_bottles" /
"members can read cellar_health" / "members can read pricing_
recommendations") and no INSERT/UPDATE/DELETE policy at all — RLS
defaults to deny for any statement type with no permissive policy of its
own, regardless of the table-level grant, so writes to these three are
blocked by policy absence, not by privilege revocation. `availability_
events` is CASCADE but RPC-gated as described above. `wine_list_items`,
`inventory_items`, and `pour_events` are `ON DELETE RESTRICT`, not
CASCADE, so a concurrent insert there makes the `DELETE` fail loudly
instead of silently losing data.

**Round 7, finding 1 — "blocked by policy absence" only ever meant a
DIRECT MEMBER insert, never the app's own writers:** round 4's correction
above was about whether a member could write these three tables through
the REST API — it was never a claim that nothing writes them. `open_
bottles`, `cellar_health`, and `pricing_recommendations` all have
legitimate, service-role writers that bypass RLS entirely (`POST
/api/open-bottles`, and the `cellar-health`/`pricing-recommendations`
recompute jobs, respectively — see the round 7 note above). None of
those writers is stopped by the policy-absence protection described
above, and none was covered by the final per-candidate re-check before
this round. They are now.

**Known gap — session-level reverts get NEITHER step:**
`revert_import_session` (0110) loops batches entirely inside Postgres,
in reverse chunk order with per-batch exception isolation, bypassing the
TypeScript layer — so a session revert can leave orphan wines AND stale
batch-written LWIN stamps behind that a per-batch revert would have
cleaned. Closing this needs either a migration (currently locked) or
restructuring `revertImportSession` to loop per-batch through the TS
layer.

Order-of-operations note (a real bug this migration's own rehearsal
caught): the function flips `apply_status` to `reverted` **before**
deleting the `inventory_items` row, not after. `applied_inventory_item_id`
references `inventory_items(id) on delete set null` — deleting first would
fire that FK action while `apply_status` was still `'applied'`, violating
`import_batch_rows_applied_has_inventory_id` on the SET NULL cascade
itself.

## Residuals — known, accepted gaps

**The cross-batch apply race is CLOSED by migration 0128 — but read the
deployment note below before assuming production has it.** Migration
`0128_apply_import_batch_chunk_sibling_lock.sql` moves enforcement inside
`apply_import_batch_chunk` itself. Before applying any row it normalises the
batch's `content_sha256` to the underlying file identity (bare 64-hex, or the
trailing 64 hex of an `overrides-v<N>:…:…` digest — generalised over `[0-9]+`
so a future namespace cannot silently escape), takes
`pg_advisory_xact_lock(hashtextextended(restaurant_id || ':' || file_digest))`,
and only then re-checks for a sibling batch with applied rows, raising `P0004`
if one exists. Because the lock is transaction-scoped and the re-check happens
under it, two concurrent sibling applies now serialise: the loser either waits
and then sees the winner's committed rows, or finds them already present.
Either way exactly one batch applies — for batches whose digest the barrier can
normalise, which since `0129` is every batch that can be created. This also covers the case the route
guard structurally could not: `apply_import_batch_chunk` is `GRANT EXECUTE`d
directly to `authenticated`, so a client calling the RPC directly bypasses the
route entirely — the barrier does not care, because it lives in the function.

*Historic digests stay grandfathered — but that state can no longer be
created.* A batch whose `content_sha256` is null (pre-0103) or unparseable takes
no lock and gets no check: its underlying file identity cannot be recovered, and
refusing those rows would break existing production imports rather than protect
anything.

That grandfathering was a bypass until migration `0129`. `create_import_batch`
(0107) accepts an unvalidated `p_content_sha256 default null` and is granted to
`authenticated`, which also holds direct insert/update on `import_batches` and
`import_batch_rows` (0076) — so a caller could manufacture two batches for one
file carrying two distinct malformed digests, or null out a valid one, and both
would skip the lock and the check. `0129` closes that with two triggers:

* `import_batches_guard_digest` (before insert or update). On INSERT it requires
  a digest matching one of the two shapes the barrier can normalise, raising
  `P0005`. On UPDATE it raises `P0005` only if the digest is *changing* —
  rewriting one valid digest into a different valid one would re-point a batch
  at another file's identity and defeat the lock just as effectively as a
  malformed one.
* `import_batch_rows_require_lockable_parent` (before insert). A grandfathered
  parent stays unlockable forever, so attaching *new* rows to one and applying it
  would walk past the barrier without ever inserting or updating a parent.
  Raises `P0007`.

**Why triggers and not a CHECK constraint.** A `not valid` CHECK looks like the
obvious spelling and is wrong here. `not valid` skips only the initial
validation scan; Postgres still enforces the constraint on every later INSERT
**and UPDATE**, including updates to the legacy rows it is supposed to
grandfather. Those rows are updated in normal operation — batch status
recomputation, and `revert_import_batch`'s parent update — so the CHECK spelling
would make every historic null-digest batch permanently unrevertable. That is
not theoretical: it broke six existing live tests, and a fabricated legacy row
proved both halves — under the trigger spelling a null-digest row still accepts
a status update, while its digest stays frozen.

Updates to existing `import_batch_rows` are deliberately *not* guarded: apply and
revert both update them, and blocking that would strand historic batches in the
same way.

*Existing violations are not repaired by the migration.* It is a function-only
change and never fails on data that already violates the invariant. If a
restaurant already has two applied batches for one file, the next apply in that
group is refused with `P0004` until an operator reverts all but one survivor.
Find them by grouping non-reverted batches with applied rows on the normalised
trailing digest.

**Deployment order matters, and the route guard stays until it is satisfied.**
Migrations reach production out-of-band — no CI step applies them — so a build
can be live before 0128 is. The pre-flight guard (`findSiblingWithAppliedRows`,
called from `POST /api/import/batches/[id]/apply`) is therefore deliberately
RETAINED: on its own it is only a TOCTOU narrowing over separate transactions,
but deleting it while production still runs 0108 would leave no protection at
all. Once 0128 is confirmed applied in production, the guard and
`findSiblingWithAppliedRows` can be deleted and the route left with only the
`P0004` → 409 mapping. Verify before deleting:

```sql
select pg_get_functiondef('public.apply_import_batch_chunk(uuid, integer)'::regprocedure)
  like '%pg_advisory_xact_lock%' as barrier_live;
```

Both layers return the identical 409 `sibling_already_applied` body (one shared
constant in the route), so which one refused is invisible to the client.

**Round-27 audit: the in-preview conflict-recovery panel is removed —
`multiple_live_batches` and `duplicate_race_retry` are reported, not
resolved, from inside the import UI.** The panel (added round-11 to make a
live-batch conflict recoverable without leaving the flow) failed five
consecutive audit rounds (18, 20, 22, 24, 26) for the same underlying
reason each time: two or more sources of guidance on screen that disagreed
with each other and with the buttons. Round 25's fix produced a new
contradiction of its own within one round. The panel, its per-candidate
revert affordance, its "standing instruction" text
(`conflictStandingInstruction`), and everything that existed only to serve
them (`visibleConflictCandidates`, `revertedConflictBatchIds`,
`conflicting-batches.ts`, the `conflictingBatches`/`conflictingBatchesCount`/
`conflictingBatchesTruncated` fields on both the client and the
`multiple_live_batches` error payload) are deleted outright rather than
patched again.

What replaced it: `PreviewStep` renders exactly ONE piece of guidance for a
conflict — the server's own `message` (built by
`reconcileLiveBatchesForFile`, `batch-service.ts`), verbatim, with no
competing standing text. Confirm/Retry stays available for both
`multiple_live_batches` and `duplicate_race_retry` (neither blocks the
button any more) — the server re-checks fresh on every confirm attempt, so
a retry that changes nothing simply re-raises the same conflict; this was
already proven safe (confirmation reconciles before `create_import_batch`,
2+ live matches return immediately, and an unchanged retry creates no
batch/rows/apply/inventory write). Recovery for `multiple_live_batches` is
through **Recent imports**, which now lists every non-reverted batch for the
restaurant (`import-client.tsx`'s `RecentImports` — no longer capped at the
newest ten), and `BatchStep`'s own "Revert this import" already accepts any
non-reverted status (round-13 audit).

**BLOCK 2 (round-25/26/27 audits): `duplicate_race_retry` no longer
escalates to an invented terminal state.** The client used to count
consecutive `duplicate_race_retry` failures and, past a fixed limit,
synthesize a distinct `duplicate_race_retry_exhausted` code that hard-blocked
Confirm/Retry and asserted "still conflicts with another live import" —
but the server defines `duplicate_race_retry` as retryable by design (a
self-revert race that may fully resolve on the very next attempt), and can
emit it with **zero** live batches for the file (`selfRevertAndRetry`,
`batch-service.ts` — both self-revert attempts failed, but nothing rival is
necessarily still live). The escalation asserted a live batch and a
recovery location (the removed panel) that might not exist. It's deleted:
the code, message, and retryability stay exactly as the server reported
them, no matter how many times it recurs.

**The `multiple_live_batches` candidate list itself was capped, not
exhaustive (WARN 5, round-13 audit) — this is now purely a
message-wording detail, not a client-visible payload.**
`findLiveBatchesByUnderlyingFile` (`src/domains/import/batch-service.ts`)
still reads at most `LIVE_BATCH_LOOKUP_LIMIT` (20) candidate rows before
format-filtering, and the conflict message still states the count as "at
least N" whenever the raw read comes back exactly at the cap, rather than
asserting a possibly-false exact total — but the per-candidate list, count,
and truncation flag are no longer carried on the error payload at all
(round-27 audit), since nothing client-side renders them any more.

**BLOCK 2 (Sol audit round 3, finding 2): `match_lwin`'s catalogue
tie-break is still non-deterministic — this makes a disagreement safe, it
does not close it.** `match_lwin` (`0078_match_lwin_trgm_fastpath.sql`)
resolves candidates with `order by score desc limit 1` and no stable
secondary key. Preview and confirm (`confirmImportBatch`,
`src/domains/import/batch-service.ts`) each call it independently — preview
when the operator loads the page, confirm again from scratch when they
click Confirm, never trusting the client's own preview payload. When two
catalogue rows genuinely tie on score, the RPC can legitimately return a
DIFFERENT `lwin_id` on the second call than it returned on the first,
purely from Postgres's own row-visitation order for that query, with
nothing in the ORDER BY to break the tie consistently. The correct fix is a
deterministic secondary `ORDER BY` key inside `match_lwin` itself — i.e. a
migration. Migrations are locked for this change.

What ships instead (`approvedLwinRows`, threaded from `PreviewStep`'s
matched-row list through `ConfirmBatchOptions.approvedLwinRows` to
`applyLwinApprovalVeto`, `batch-service.ts`): the client echoes back, per
row it showed as a linking match (score >= `LWIN_APPLY_MIN_SCORE`), the
exact `lwin_id` the operator saw and accepted. Confirm still ALWAYS
re-derives the match itself and never trusts that value as anything but a
comparison target — when the re-derived match disagrees with what the
operator approved, the row is stamped exactly like a rejected row (no LWIN
link at all) instead of silently persisting whichever candidate the tie
happened to resolve to on that particular call. This can only ever cause
LESS to be written than an untrusted client value could, never more or
different — the same "confirm never trusts a client-supplied preview"
property every other field in `ConfirmBatchOptions` already holds. The
residual this leaves: a genuine tie is still resolved non-deterministically
by the RPC, so an operator can occasionally see a row silently drop to
"unmatched, needs resolution" between preview and confirm with no
value-level "wrong wine" ever persisted — annoying, not unsafe. Closing
that properly (the RPC itself returning the SAME candidate every time)
still needs the migration described above.

**BLOCK 1 (round 5 audit): the veto above was fail-OPEN for a row the
operator never saw as linking at all — corrected, now fail-closed.**
`buildApprovedLwinRows` (`import-client.tsx`) only ever includes a row that
was shown as LINKING (score >= `LWIN_APPLY_MIN_SCORE`) at preview — a row
that was unmatched, or matched below that bar, has no entry either way, for
the exact same "no entry" shape. Before this round, `applyLwinApprovalVeto`
left ANY row with no entry completely untouched, on the theory that "no
entry" only ever meant "an older client, or a row never shown as matched."
That reasoning missed a real case: if a row that was unmatched or
below-threshold at PREVIEW re-scores >= `LWIN_APPLY_MIN_SCORE` by the time
confirm re-derives it from scratch (a catalogue update between the two
calls, or `match_lwin`'s own non-deterministic tie-break landing on a
candidate this time), the old veto stamped it — a catalogue link the
operator never saw, contradicting this same UI's own promise that a
below-threshold/unmatched row imports with no link "no matter what you do
here" (`import-client.tsx`'s `PreviewStep`).

The fix: `ConfirmBatchOptions.approvedLwinRows`'s mere PRESENCE (checked via
`!== undefined`, independent of whether it canonicalizes to anything) now
tells `applyLwinApprovalVeto` the client showed the operator its full
linking picture for this confirm. `import-client.tsx` (both the plain and
chunked confirm paths) now ALWAYS sends this field, even as `{}` for a file
whose preview showed zero linking matches — omitting it for an
all-non-linking file used to be indistinguishable from an older, non-UI
client that never sends it at all, which was exactly the ambiguity behind
the bug. When the field is present, every row that would actually be
stamped (matched, score >= `LWIN_APPLY_MIN_SCORE`) now needs a MATCHING
entry to survive — no entry, same as a disagreeing one, both veto. When the
field is genuinely absent (a bare API caller with no preview UI to show
anything through), the veto is unchanged from before: there is no signal to
fail closed with, and absence of data is never treated as evidence of
rejection. The "never trust the client, can only cause LESS to be written"
property is unchanged either way. This changed the digest input shape for
one previously-impossible state (`approvedLwinRows` sent but empty) — see
`confirmImportBatch`'s own digest-construction comment for the new v4
namespace this required, kept fully separate from v1/v2/v3 so the new
full-picture-veto semantics can never collide, digest-wise, with an
old-style permissive confirm of the same file/overrides/rejections.

## added_via provenance

CSV-imported `inventory_items` rows keep `added_via = 'manual'` rather than
adding a new enum value. Postgres enum types cannot drop a value — that
was exactly what made G1-6's first down-migration attempt fail (see
`docs/runbooks/migration-numbering.md`-adjacent history in 0075's down).
Provenance here is tracked precisely by
`import_batch_rows.applied_inventory_item_id` (which batch **and which
row** created a given inventory row) instead — strictly more informative
than a coarse enum tag, and it keeps 0076's down migration a plain
`DROP TABLE`.
