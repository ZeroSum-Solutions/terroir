-- Reverse of 0016_pour_tracking.sql (BND-038)
-- CAUTION: dropping pour_events destroys the pour ledger. Archive
-- first if history matters:
--   create table pour_events_archive as select * from pour_events;

-- 1. Drop RPCs that depend on the tables + trigger function.
drop function if exists public.record_pour(uuid, int, text, text);
drop function if exists public.reconcile_open_bottle(uuid, int, text);

-- 2. Drop the trigger + its function.
drop trigger if exists pour_events_trigger on public.pour_events;
drop function if exists public.pour_events_maintain_open_bottle();

-- 3. Drop the two new tables (CASCADE for indexes + RLS policies).
drop table if exists public.pour_events cascade;
drop table if exists public.open_bottles cascade;

-- 4. Drop the columns on wine_list_items.
alter table public.wine_list_items
  drop column if exists glass_pour_ml,
  drop column if exists pour_size_mode;
