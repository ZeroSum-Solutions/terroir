-- Reverse of 0077_inventory_fk_perf_indexes.sql
-- Drops the two partial indexes; the tables and their data are untouched.

drop index if exists public.import_batch_rows_applied_inventory_item_id_idx;
drop index if exists public.open_bottles_source_inventory_item_id_idx;
