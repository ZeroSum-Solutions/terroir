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
batch's apply created, and `clearBatchLwinStamps` clears
`wines.lwin_id`/`lwin_match_score` stamps this batch's apply left live.
The route response reports both counts, plus `cleanupTruncated` (see
"Cleanup is bounded" below) and `orphanCleanupSkipped` (round 4, finding
6 — set when `cleanupOrphanWines` specifically couldn't run because no
service-role client was available; see "Cross-tenant reference checks run
on the service-role client" below). **Round 4, finding 3:** the revert
confirmation dialog (`src/app/(app)/import/import-client.tsx`) states
plainly that revert also deletes wines and clears LWIN links this import's
apply set — it used to promise "nothing else in your cellar is touched,"
which was false given these two steps — and the success view after a
revert reports the actual `revertedCount`/`orphanWinesDeleted`/
`lwinStampsCleared`, plus a partial-cleanup notice when `cleanupTruncated`
or `orphanCleanupSkipped` is set, instead of discarding the response body.

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
  run once in bulk and then again, single-wine, immediately before each
  delete.
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

If the service-role client is unavailable (misconfigured environment —
`SUPABASE_SERVICE_ROLE_KEY` missing or invalid; see
`src/lib/supabase/service-role.ts`), `cleanupOrphanWines` skips deletion
entirely for that revert (logs and returns zero) rather than falling back
to the RLS-scoped client — falling back would silently reintroduce the
exact risk above. **Round 4, finding 6:** this used to be silent past a
server log — `RevertBatchResult.orphanCleanupSkipped` now says so
explicitly in the revert route's own response, and the client surfaces it
in the revert success message ("Catalog cleanup was skipped — service
configuration missing"). This flag is about `cleanupOrphanWines`
specifically, not `clearBatchLwinStamps` — the LWIN unstamp needs no
service-role client and still runs normally even when this flag is true.
The required env var is documented in `docs/LOCAL-SUPABASE.md`'s
Environment section (`SUPABASE_SERVICE_ROLE_KEY`) for local dev;
`docs/STAGING-SETUP.md` does not enumerate a per-service env-var
checklist, so there is nothing to add there. Live proof:
`src/domains/import/tenant-isolation.test.ts`, "bar 5" — a tenant-B
`stock_adjustments` row naming tenant A's applied wine, seeded through
tenant B's own RLS-scoped client exactly as a real attacker would, must
survive tenant A's revert, and the wine must survive too.

**Round 4, finding 1 — checked LAST, immediately before the DELETE:**
`findReferencedWineIds` runs the cross-batch `import_batch_rows` check
first, then every `WINE_REFERENCING_TABLES` table in the array's own
order — which now ends with `stock_adjustments` and `bottle_closeouts`
(moved from `stock_adjustments` FIRST in an earlier revision). Those two
are the only tables in the list a cross-tenant write can target, so
putting them last makes them the final requests issued before the
caller's next request — the `DELETE`, for the single-wine re-check call —
shrinking that specific TOCTOU window from ~10 round-trips to one. See
"Cleanup is bounded" below for what that narrowed window still allows and
why it's accepted rather than closed outright.

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
round 4, finding 2.) Batches support up to 5,000 applied rows (`MAX_ROWS`,
`src/domains/import/constants.ts`). Two bounds keep cleanup from blowing
the revert route's 30s `maxDuration`:

- **Chunked `.in()` queries.** Every reference-existence or wine-lookup
  query built from a candidate-id array chunks the ids to at most 100 per
  request (`IN_CLAUSE_CHUNK_SIZE`, `batch-service.ts`) — at 5,000
  candidates, one unchunked `.in()` could carry ~156,000 characters in a
  single request URL.
- **A soft wall-clock deadline** (`CLEANUP_BUDGET_FROM_ENTRY_MS`,
  20,000ms — renamed round 4 from `CLEANUP_SOFT_BUDGET_MS`; see its own
  comment in `src/domains/import/constants.ts` for the exact arithmetic
  against the 30s route budget) shared across BOTH cleanup steps
  combined, and — this is the round-4 fix — measured from
  `revertImportBatch`'s own ENTRY, before the applied-rows snapshot read
  and the `revert_import_batch` RPC call, neither of which is ever
  subject to it. Round 3's version started the clock only after both had
  already completed, which left a slow snapshot read (paginated,
  unbounded page count) or a slow RPC call able to consume most of the
  route's 30s before cleanup's own budget even began counting. The
  deadline is checked before EVERY request the cleanup phase issues —
  each `.in()` chunk of a candidate lookup, each table×chunk request of
  the reference sweep, each query of the per-candidate re-check, and
  immediately before each `DELETE`/`UPDATE` — not merely once per
  per-candidate loop iteration, which is what let round 3's version start
  a candidate lookup of up to 50 sequential requests, or a bulk sweep of
  up to ~500, with no check anywhere inside either. Once the deadline
  passes, cleanup stops before issuing its next request rather than
  finishing the one already in flight and then checking — a fresh
  per-wine reference re-check alone issues ~10 sequential requests (9
  `WINE_REFERENCING_TABLES` + 1 cross-batch `import_batch_rows` check),
  so at scale that's the dominant cost. The counts returned are always
  exactly what genuinely ran — never padded or estimated — and the
  response carries `cleanupTruncated: true` plus a log line so the
  operator knows more candidates were left untouched.

**Re-run path when cleanup is truncated:** re-running revert itself is
not meaningful (the batch is already reverted) — the recovery is the
same as any other cleanup shortfall: a manual cleanup pass, or (for a
truncated LWIN unstamp) re-running LWIN matching against the affected
wines.

**Residuals that remain, honestly, rather than being claimed away:**
(a) two distinct apply-chunk transactions landing on the exact same
microsecond timestamp would be indistinguishable — negligible, accepted;
(b) the reference re-check and the `DELETE` are still separate requests,
so ANY referencing table can in principle receive a fresh, cascade-linked
insert in the gap between them. For seven of the nine
`WINE_REFERENCING_TABLES` this gap is same-tenant-only:
`availability_events` writes only go through the SECURITY DEFINER
`set_wine_availability` RPC, which derives its own `restaurant_id` from
the wine and requires an owner/manager of THAT restaurant; `inventory_
items`, `wine_list_items`, and `pour_events` are `ON DELETE RESTRICT`, not
CASCADE, so a concurrent insert there makes the `DELETE` fail outright
instead of losing data, caught per-wine and skipped, never silently
pretended to have succeeded. `stock_adjustments`
(`src/app/api/stock-adjustments/route.ts`) and `bottle_closeouts`
(RLS-insertable directly, even though the app's own `close_open_bottle`
RPC path, `src/app/api/open-bottles/close/route.ts`, IS tenant-safe and
requires a live open bottle) are the only two where the gap is
cross-tenant reachable — neither requires live inventory to write via a
direct RLS insert, and neither's INSERT policy checks that `wine_id`
belongs to the inserting tenant. **Round 4, finding 1 (shrink, not
close):** `findReferencedWineIds` (`batch-service.ts`) checks both of
these two tables LAST — after every other table and the cross-batch
check — so they're the last requests issued before the `DELETE` that
follows a re-check, shrinking this specific cross-tenant window from
~10 round-trips down to a single one. It is a narrowing, not a closure: a
cross-tenant insert into one of those two tables landing in that final
round-trip is still possible in principle. What makes the narrowed
residual acceptable: the ONLY way a cross-tenant row can occupy that
window at all is by exploiting the pre-existing gap in
`stock_adjustments`'/`bottle_closeouts`' own INSERT policies (see the
next section) — no product code path this app ships ever writes a
`wine_id` outside its own tenant, so any row that shows up there naming
another tenant's wine is necessarily a deliberate malicious insert
exploiting that policy gap, never innocent concurrent activity; the
forger is the only party who can lose that row, and only by choosing to
exploit a vulnerability that already lets them attach arbitrary rows to a
wine they don't own. The two fixes that would close the window outright —
an ownership `WITH CHECK` on those two tables' INSERT policies (closing
the underlying policy gap directly), or moving the re-check and the
`DELETE` into one `SECURITY INVOKER` RPC transaction (closing the window
itself) — are both migration-gated and out of reach for this TS-layer-
only pass; tracked here until the migration lock lifts, same as the
"Known gap" below; (c) for the LWIN unstamp, a third party writing the
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
