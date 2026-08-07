drop function if exists public.complete_cellar_wine_delete_idempotency(
  uuid,
  text,
  text,
  text,
  jsonb
);
drop function if exists public.delete_cellar_wine_idempotent(
  uuid,
  uuid,
  text,
  text
);
drop function if exists public.add_cellar_wine_idempotent(
  uuid,
  text,
  text,
  integer,
  text,
  text,
  text,
  integer,
  numeric,
  text,
  text
);
