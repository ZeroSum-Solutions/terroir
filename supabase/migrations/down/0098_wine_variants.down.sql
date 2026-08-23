-- down for 0098_wine_variants.sql
begin;

drop trigger if exists wines_derive_canonical_wine_id on public.wines;
drop function if exists public.wines_derive_canonical_wine_id();

alter table public.wine_lineages drop column if exists canonical_wine_id;

alter table public.wines drop constraint if exists wines_variant_tenant_fk;
drop index if exists public.wines_wine_variant_id_idx;
drop index if exists public.wines_canonical_wine_id_idx;
alter table public.wines drop column if exists canonical_wine_id;
alter table public.wines drop column if exists wine_variant_id;

drop policy if exists "members can update wine_variants" on public.wine_variants;
drop policy if exists "members can insert wine_variants" on public.wine_variants;
drop policy if exists "members can read wine_variants" on public.wine_variants;
drop trigger if exists wine_variants_set_updated_at on public.wine_variants;
drop table if exists public.wine_variants;

commit;
