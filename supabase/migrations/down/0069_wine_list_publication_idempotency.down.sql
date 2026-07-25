-- Reverse migration 0069.
drop function if exists public.set_wine_list_publication_idempotent(
  uuid,
  uuid,
  boolean,
  boolean,
  text,
  text,
  text
);
drop function if exists public.clone_wine_list_idempotent(
  uuid,
  uuid,
  text,
  text
);
