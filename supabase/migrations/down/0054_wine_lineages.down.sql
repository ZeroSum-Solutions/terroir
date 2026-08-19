-- 0054_wine_lineages.down.sql

drop function if exists public.merge_wines(uuid, uuid);

drop trigger if exists wines_derive_lineage on public.wines;
drop function if exists public.derive_wine_lineage();

drop index if exists public.wines_lineage_id_idx;
alter table public.wines drop column if exists lineage_id;

drop policy if exists "members can read wine_lineages" on public.wine_lineages;
drop table if exists public.wine_lineages;
