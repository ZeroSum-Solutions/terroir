-- Reverse of 0062_reconcile_idempotency.sql.

drop function if exists public.reconcile_open_bottles_idempotent(
  uuid,
  jsonb,
  text,
  text
);
