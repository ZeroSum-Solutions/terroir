-- Reverse of 0086_import_batch_rows_delete_guard.sql

drop trigger if exists inventory_items_reflect_import_delete on public.inventory_items;
drop function if exists public.import_batch_rows_reflect_inventory_delete();
