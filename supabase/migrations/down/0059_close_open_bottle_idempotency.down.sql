-- Reverse of 0059_close_open_bottle_idempotency.sql.

drop function if exists public.close_open_bottle_idempotent(
  uuid,
  uuid,
  timestamptz,
  text,
  text
);
