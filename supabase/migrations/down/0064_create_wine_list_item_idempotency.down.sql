-- Reverse of 0064_create_wine_list_item_idempotency.sql.

drop function if exists public.create_wine_list_item_idempotent(
  uuid,
  uuid,
  uuid,
  numeric,
  numeric,
  text,
  text,
  text
);
