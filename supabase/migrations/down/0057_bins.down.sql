-- 0057_bins.down.sql

alter table public.wine_lists drop column if exists show_bin_codes;

drop index if exists public.inventory_items_bin_id_idx;
alter table public.inventory_items drop column if exists bin_id;

drop policy if exists "managers can update bins" on public.bins;
drop policy if exists "managers can insert bins" on public.bins;
drop policy if exists "members can read bins" on public.bins;

drop table if exists public.bins;
