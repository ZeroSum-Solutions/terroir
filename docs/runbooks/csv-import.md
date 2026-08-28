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
  call, per chunk — still well inside one request even at the 5,000-row
  cap.

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
batch's apply *provably* created, and `clearBatchLwinStamps` clears
`wines.lwin_id`/`lwin_match_score` stamps this batch's apply *provably*
wrote onto surviving wines. The route response reports both counts.

Both steps rest on one fact, verified against `apply_import_batch_chunk`
(0108) and the `wines_set_updated_at` trigger (0002): one apply-chunk RPC
*call* is one Postgres transaction, so every row it touches in that call
— the wine it upserts AND the `import_batch_rows` row it marks applied —
shares exactly one `now()`. `revertImportBatch` reads a snapshot of this
batch's applied rows (id, `applied_wine_id`, `updated_at`, `lwin_id`,
`lwin_score`) **before** calling `revert_import_batch`, because that RPC
itself sets `updated_at = now()` on every row it reverts — reading after
would destroy the evidence.

- **`cleanupOrphanWines`** deletes a wine only when some snapshot row's
  own `updated_at` exactly equals that wine's `created_at` — proof the
  wine was created in that row's own apply-chunk transaction, not a
  guess about a time window. (This replaces an earlier, incorrect
  `wines.created_at >= batch.created_at` heuristic, whose write-up wrongly
  claimed every product write path that creates a wine also creates a
  referencing row in the same operation; real bare-wine paths exist —
  `src/app/api/cellar/route.ts`, `src/app/api/inventory/save-scan/
  route.ts`, and `src/app/api/wines/create-from-lwin/route.ts`, the last
  of which gets a `wine_list_items` reference only from a later, separate
  user action.) Reference checks (the 9-table sweep plus other batches'
  `applied_wine_id` claims) run once in bulk and then again, single-wine,
  immediately before each delete.
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
  "prefers higher score" upsert logic.)

**Residuals that remain, honestly, rather than being claimed away:**
(a) two distinct apply-chunk transactions landing on the exact same
microsecond timestamp would be indistinguishable — negligible, accepted;
(b) the reference re-check and the DELETE are still separate requests, so
`stock_adjustments` (`src/app/api/stock-adjustments/route.ts`) or
`availability_events` (`src/app/api/wines/[id]/availability/route.ts`) —
neither of which requires live inventory to write a cascade-linked row —
can insert in that gap and get destroyed by the `ON DELETE CASCADE` on
`wine_id`; `inventory_items.wine_id` is `ON DELETE RESTRICT`, so a
concurrent inventory insert in that same gap makes the DELETE fail
outright instead, caught per-wine and skipped, never silently pretended
to have succeeded; (c) for the LWIN unstamp, a third party writing the
exact `(lwin_id, lwin_match_score)` pair a row's own LWIN match would
independently compute, before apply ran, on a wine that row also
dedup-matches, passes both checks by coincidence — this requires guessing
a specific trigram-similarity float to exact precision ahead of time,
the same order of residual as (a).

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
