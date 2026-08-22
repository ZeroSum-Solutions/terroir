# CSV cellar import (G1-4)

Bulk cellar onboarding: upload a CSV of existing inventory, preview it with
zero database writes, confirm it as a persisted batch, then apply it in
bounded chunks. See `supabase/migrations/0076_csv_import_batches.sql` for
the schema and `src/domains/import/*` for the implementation.

## Size threshold and the decision not to use a background job

Precondition G1-6 shipped `background_jobs` claim/reclaim machinery
(`src/lib/jobs/*`) for exactly this kind of "might be slow" work. This
slice deliberately does **not** wire a `csv_import` job type through it.

**The threshold:** `MAX_UPLOAD_BYTES` = 5 MB and `MAX_ROWS` = 5,000 data
rows (`src/domains/import/constants.ts`). Above either limit the upload is
rejected outright (413 / a preview-time row-count error) rather than
silently truncated.

**Why chunked synchronous calls instead of a worker, within that
threshold:**

- The Railway worker service (`railway.worker.toml`, from G1-6) is **not
  deployed anywhere yet**. Depending on it for a first-customer-critical
  flow would mean this slice ships nothing runnable until a separate
  deploy lands.
- A restaurant's actual existing cellar is realistically hundreds to low
  thousands of SKUs — comfortably inside the 5,000-row cap.
- `apply_import_batch_chunk` (0076) processes `APPLY_CHUNK_SIZE = 100`
  rows per call, each row wrapped in its own exception handler. A route
  handler call that only ever touches ≤100 rows has no meaningful risk of
  hitting a platform request-timeout, at any file size up to the cap — the
  client just calls `/apply` again until `done: true`. This is what makes
  the design resumable (bar 2) without needing a durable out-of-request
  worker: the "resume" primitive is a second HTTP call, not a job retry.
- Preview (`buildImportPreview`) does the same bulk LWIN-matching work
  synchronously, bounded by `LWIN_MATCH_BATCH_SIZE = 300` rows per RPC
  call — still well inside one request even at the 5,000-row cap.

**When this stops being true:** if onboarding needs change (e.g. a
customer's existing POS export routinely exceeds 5,000 rows, or the
preview/confirm round trip starts timing out in production), the row cap
is the signal to revisit this decision — at that point, wire a
`csv_import` job type through `src/lib/jobs/*` reusing the existing
claim/reclaim pattern (extend `background_jobs_job_type_check`, add a
`claim_csv_import_job` / `reclaim_stuck_csv_import_jobs` pair following
0075's), rather than forking a second job-runner implementation. The
`import_batches` / `import_batch_rows` schema does not need to change for
that — a worker would call the exact same `apply_import_batch_chunk` RPC
in a loop instead of a route handler doing so.

## Preview is a pure function

`buildImportPreview` (`src/domains/import/preview-service.ts`) parses,
validates, and LWIN-matches a CSV with **zero database writes** — the only
network call it makes is the read-only `match_lwin_bulk` RPC (0076). Both
`POST /api/import/preview` (stops there) and `POST /api/import/batches`
(persists the same computation as a batch) call it — the confirm endpoint
always re-derives from the uploaded file itself, never trusts a
client-supplied preview payload.

## Reversibility

`revert_import_batch` (0076) deletes exactly the `inventory_items` rows
recorded in `import_batch_rows.applied_inventory_item_id` for one batch's
applied rows, and only when the batch's status is `completed`. It never
touches wines, never touches another batch's rows, and never touches
inventory that predates the import — see
`src/domains/import/tenant-isolation.test.ts` for a live-Postgres proof
against a restaurant with pre-existing inventory for the same wine.

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
