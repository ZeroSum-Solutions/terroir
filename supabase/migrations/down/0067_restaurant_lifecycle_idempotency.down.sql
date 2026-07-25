drop function if exists public.delete_restaurant_idempotent(
  uuid,
  uuid,
  text,
  text
);

delete from public.api_idempotency
where not exists (
  select 1
  from public.restaurants
  where restaurants.id = api_idempotency.restaurant_id
);

alter table public.api_idempotency
  add constraint api_idempotency_restaurant_id_fkey
  foreign key (restaurant_id)
  references public.restaurants(id)
  on delete cascade;

comment on column public.api_idempotency.restaurant_id is null;
