-- 0020_schedule_cleanup_scan_idempotency.sql — INT-013
--
-- scan_idempotency rows TTL at 24h (cleanup_scan_idempotency() was
-- added in 0011) but nothing ever called the function, so the table
-- grew unbounded in production. This migration enables pg_cron (in
-- Supabase's `extensions` schema — the Supabase convention) and
-- schedules an hourly run.
--
-- The 24h TTL + hourly sweep means at most 25 hours of idempotency
-- keys are ever live — sufficient overlap for network retries but
-- bounded storage for any tenant.

create extension if not exists pg_cron with schema extensions;

-- Schedule hourly at :05 so the job doesn't collide with Supabase's
-- own top-of-hour maintenance sweeps. 'idempotent' schedule name —
-- re-running this migration is safe (cron.schedule upserts by name).
select cron.schedule(
  'cleanup_scan_idempotency_hourly',
  '5 * * * *',
  $$select public.cleanup_scan_idempotency();$$
);
