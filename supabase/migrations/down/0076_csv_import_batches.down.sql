-- down for 0076_csv_import_batches.sql
--
-- DOWN-PATH DATA POLICY: this migration's down is a plain schema
-- teardown, not a destructive one. Unlike G1-6's down (0075), which had
-- to delete background_jobs rows using vocabulary the restored
-- constraints couldn't hold, this feature's data lives entirely in two
-- tables it owns outright (import_batches, import_batch_rows) and never
-- extends a vocabulary on an existing table. Dropping those two tables
-- removes every row this feature ever wrote; nothing pre-existing is
-- touched, because nothing pre-existing was modified by the up
-- migration in the first place.
--
-- inventory_items rows a completed, un-reverted import batch created
-- are NOT deleted by this down migration. They are ordinary
-- inventory_items rows at that point (added_via = 'manual', same as any
-- manually-entered bottle) with no schema dependency on the tables being
-- dropped — import_batch_rows.applied_inventory_item_id is a foreign key
-- FROM the table being dropped TO inventory_items, so dropping
-- import_batch_rows only removes that FK, never the inventory rows it
-- pointed at. If an operator wants those bottles gone, revert the batch
-- (via revert_import_batch) BEFORE running this down — once the down has
-- run, the traceability that made revert possible (which row created
-- which inventory item) is gone along with the dropped tables.
--
-- Wrapped in a single transaction: if any DROP fails partway, the whole
-- rollback is undone rather than leaving the schema in a state that
-- matches neither pre- nor post-0076.

begin;

revoke execute on function public.revert_import_batch(uuid) from authenticated;
drop function if exists public.revert_import_batch(uuid);

revoke execute on function public.apply_import_batch_chunk(uuid, integer) from authenticated;
drop function if exists public.apply_import_batch_chunk(uuid, integer);

revoke execute on function public.match_lwin_bulk(jsonb, float) from authenticated;
drop function if exists public.match_lwin_bulk(jsonb, float);

-- Policies and indexes are dropped implicitly with their tables.
-- import_batch_rows first (it FKs to import_batches).
drop table if exists public.import_batch_rows;
drop table if exists public.import_batches;

commit;
