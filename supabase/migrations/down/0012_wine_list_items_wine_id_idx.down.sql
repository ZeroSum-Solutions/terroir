-- Reverse of 0012_wine_list_items_wine_id_idx.sql
-- Drops the index; the table itself is untouched.

drop index if exists public.idx_wine_list_items_wine_id;
