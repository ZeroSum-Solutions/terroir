-- down for 0097_canonical_wines.sql
begin;

drop policy if exists "members can insert canonical_wines" on public.canonical_wines;
drop policy if exists "anyone authenticated can read canonical_wines" on public.canonical_wines;
drop trigger if exists canonical_wines_set_updated_at on public.canonical_wines;
drop table if exists public.canonical_wines;

commit;
