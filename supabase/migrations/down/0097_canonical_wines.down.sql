-- down for 0097_canonical_wines.sql
begin;

drop policy if exists "members can insert canonical_wines" on public.canonical_wines;
drop policy if exists "anyone authenticated can read canonical_wines" on public.canonical_wines;
drop trigger if exists canonical_wines_set_updated_at on public.canonical_wines;
-- canonical_wines_lwin7_requires_verified (round 5) is dropped along with
-- the table below (constraints aren't standalone objects). identity_
-- normalize_text() IS standalone (also used by 0101's backfill) and needs
-- an explicit drop.
drop table if exists public.canonical_wines;
drop function if exists public.identity_normalize_text(text);

commit;
