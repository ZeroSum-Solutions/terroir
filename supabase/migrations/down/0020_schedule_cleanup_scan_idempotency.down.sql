-- Reverse of 0020_schedule_cleanup_scan_idempotency.sql
-- Unschedules the cron job. Keeps pg_cron installed since other
-- jobs may share the extension.

select cron.unschedule('cleanup_scan_idempotency_hourly');
