-- Reverse of 0021_auto_eightysix.sql (BND-037b)
--
-- Leaves any availability_events rows with note='auto: below threshold'
-- in place — history is immutable. Any wines that got auto-86'd stay
-- 86'd; a manager restores them manually via /availability.

drop trigger if exists pour_events_trigger_auto_eightysix on public.pour_events;
drop function if exists public.auto_eightysix_on_low_inventory();

alter table public.restaurants
  drop column if exists auto_eightysix_from_inventory,
  drop column if exists eightysix_ml_threshold;
