-- Down for 0022_auto_eightysix_owner_only.sql (INT-019).
-- Drops the trigger + trigger function, restoring pre-0022 behavior
-- where managers could write the auto-86 columns directly via RLS.

drop trigger if exists restaurants_enforce_owner_for_auto_eightysix on public.restaurants;
drop function if exists public.enforce_owner_for_auto_eightysix_update();
