-- Reverse of 0066_confirm_bottle_scan_idempotency.sql.

drop function if exists public.confirm_bottle_scan_idempotent(
  uuid,
  uuid,
  text,
  text,
  text,
  text
);
