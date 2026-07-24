-- Reverse of 0058_open_bottle_idempotency.sql.

drop function if exists public.open_bottle_from_inventory_idempotent(
  uuid,
  uuid,
  text,
  text
);
