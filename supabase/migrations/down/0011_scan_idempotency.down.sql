-- Reverse of 0011_scan_idempotency.sql
-- Drop order: function → policy (auto) → table. CASCADE handles the
-- index + RLS policy + any dependent grants.

drop function if exists public.cleanup_scan_idempotency();
drop table if exists public.scan_idempotency cascade;
