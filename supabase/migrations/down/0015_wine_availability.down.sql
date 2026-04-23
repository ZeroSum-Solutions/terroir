-- Reverse of 0015_wine_availability.sql (BND-037)
-- CAUTION: dropping the availability_events table destroys audit
-- history. If you need a restore path that preserves history,
-- archive the table first:
--   create table availability_events_archive as select * from availability_events;
-- ...then run this migration.

-- 1. Drop the RPC that uses the table.
drop function if exists public.set_wine_availability(uuid, text, text);

-- 2. Drop the audit table.
drop table if exists public.availability_events cascade;

-- 3. Re-grant the column-level UPDATE that 0015 revoked so the DOWN
-- leaves the permissions matrix where 0014 left it.
grant update (is_eightysixed, eightysixed_at, eightysixed_by)
  on public.wines to authenticated;

-- 4. Drop the index + columns on wines.
drop index if exists public.wines_eightysixed_idx;
alter table public.wines
  drop column if exists is_eightysixed,
  drop column if exists eightysixed_at,
  drop column if exists eightysixed_by;
