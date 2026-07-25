-- Reverse of 0060_record_pour_idempotency.sql.

drop function if exists public.record_pour_idempotent(
  uuid,
  uuid,
  int,
  text,
  text,
  text,
  text
);
