-- C12 (db audit 2026-08-23) — missing indexes on FK columns pointing at
-- inventory_items make revert_import_batch (0076) O(n) full-table scans
-- per reverted row, i.e. O(n * table_size) overall.
--
-- revert_import_batch loops once per applied row and issues
--   delete from public.inventory_items where id = ... ;
-- Every such delete makes Postgres check the two tables with an FK
-- pointing at inventory_items for referencing rows, regardless of the
-- ON DELETE action (SET NULL still has to find the rows to null out):
--   import_batch_rows.applied_inventory_item_id  (on delete set null)
--   open_bottles.source_inventory_item_id        (on delete set null)
-- Neither column had an index, so each FK-integrity check was a full
-- sequential scan of the child table — repeated once per deleted row.
--
-- Verified (.../scratchpad/db-audit/verify/V4-bottles.md, C12): at a
-- 15,001-row import_batch_rows table, EXPLAIN ANALYZE showed the
-- import_batch_rows FK-check trigger alone drop from 5.339ms to 0.078ms
-- (68x) once this index existed; pg_stat_user_tables showed exactly one
-- extra full sequential scan of import_batch_rows per deleted
-- inventory_items row (5,000 deletes -> 5,000 seq scans, ~50M tuples
-- read); a real 5,000-row revert_import_batch call (through the live
-- PostgREST RPC, as an authenticated tenant) dropped from 4,444ms to
-- 1,220ms (3.6x) with the index present, and the gap widens as
-- import_batch_rows grows, since it is an append-only audit trail that
-- is never deleted (rows are only ever flipped to 'reverted').
--
-- Both columns are nullable and populated in exactly one lifecycle
-- state (applied_inventory_item_id: only while apply_status =
-- 'applied'; source_inventory_item_id: only for a bottle opened from a
-- tracked inventory row), so a partial index — matching the auditors'
-- fix sketch — covers every row either the FK trigger or
-- revert_import_batch ever look up while staying small relative to the
-- full table.
--
-- Other unindexed FK columns exist elsewhere in this schema (e.g. the
-- *_by/*_user_id audit columns pointing at auth.users, and a handful of
-- wine_id FKs — see the fix-lane report for the full catalog query and
-- results). None of them sit behind a bulk per-row delete loop the way
-- inventory_items does under revert_import_batch: auth.users rows are
-- never bulk-deleted by any app write path, and the wines-table deletes
-- in merge_wines (0055) remove exactly one row per call, not N rows in
-- one transaction, so the O(n * table_size) pattern this migration
-- fixes does not apply to them. Left alone — no measurement or
-- reachable write path justifies indexing them right now.
--
-- Lock note: CREATE INDEX CONCURRENTLY cannot run inside a transaction
-- block, and — per the precedent in 0012_wine_list_items_wine_id_idx.sql
-- — this repo's migration runner (local `supabase db reset` and CI)
-- applies every migration inside one. This migration therefore uses the
-- plain (non-concurrent) form, matching that precedent; both tables are
-- a few thousand to ~20k rows in every environment this has been tested
-- against today, so the AccessExclusiveLock window is well under a
-- second. If this is ever applied by hand to a live database where
-- import_batch_rows/open_bottles have grown large enough that an
-- AccessExclusiveLock would be disruptive, an operator should instead
-- run the CONCURRENTLY form below manually, outside the normal
-- migration pipeline, before marking this migration applied:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS
--     import_batch_rows_applied_inventory_item_id_idx
--     ON public.import_batch_rows (applied_inventory_item_id)
--     WHERE applied_inventory_item_id IS NOT NULL;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS
--     open_bottles_source_inventory_item_id_idx
--     ON public.open_bottles (source_inventory_item_id)
--     WHERE source_inventory_item_id IS NOT NULL;
--
-- DOWN:
--   DROP INDEX IF EXISTS public.import_batch_rows_applied_inventory_item_id_idx;
--   DROP INDEX IF EXISTS public.open_bottles_source_inventory_item_id_idx;

create index if not exists import_batch_rows_applied_inventory_item_id_idx
  on public.import_batch_rows (applied_inventory_item_id)
  where applied_inventory_item_id is not null;

create index if not exists open_bottles_source_inventory_item_id_idx
  on public.open_bottles (source_inventory_item_id)
  where source_inventory_item_id is not null;
