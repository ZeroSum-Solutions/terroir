-- Down for 0023_wines_availability_owner_manager_trigger.sql (DEBT-023).
-- Drops the trigger + trigger function, restoring pre-0023 behavior
-- where owner/manager/staff members could all write the three
-- availability columns directly via RLS (bypassing audit logging).
-- Migration 0015's column-level REVOKE is a Postgres no-op and
-- provides no actual enforcement after this is dropped.

drop trigger if exists wines_enforce_owner_manager_for_availability on public.wines;
drop function if exists public.enforce_owner_or_manager_for_wine_availability_update();
