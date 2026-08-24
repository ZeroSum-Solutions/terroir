-- down for 0099_wine_identity_resolution.sql
begin;

revoke execute on function public.resolve_wine_variants_bulk(uuid, jsonb) from authenticated;
drop function if exists public.resolve_wine_variants_bulk(uuid, jsonb);

drop policy if exists "insert canonical-scoped or own-tenant wine_aliases" on public.wine_aliases;
drop policy if exists "read canonical-scoped or own-tenant wine_aliases" on public.wine_aliases;
drop table if exists public.wine_aliases;

commit;
