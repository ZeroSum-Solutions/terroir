-- TER-024 — make root tenant deletion compatible with wine history guards.
--
-- Several tenant-owned tables intentionally use ON DELETE RESTRICT for an
-- individual wine deletion. PostgreSQL checks those constraints before the
-- restaurant's independent cascades can remove the same rows, so deleting the
-- tenant root must clear the known dependent rows in a deterministic order.

create or replace function public.prepare_restaurant_deletion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- The pour reversal trigger needs the live open-bottle row, so remove the
  -- append-only events before the restaurant cascade reaches open_bottles.
  delete from public.pour_events
  where restaurant_id = old.id;

  -- A list item restricts deletion of its wine even though its parent list and
  -- the wine are both owned by this restaurant and otherwise cascade.
  delete from public.wine_list_items as item
  using public.wines as wine
  where item.wine_id = wine.id
    and wine.restaurant_id = old.id;

  -- Receipt inventory likewise protects individual wine history but belongs
  -- to the tenant graph when the restaurant itself is deleted.
  delete from public.inventory_items
  where restaurant_id = old.id;

  return old;
end;
$$;

revoke all on function public.prepare_restaurant_deletion() from public;
revoke all on function public.prepare_restaurant_deletion() from anon;
revoke all on function public.prepare_restaurant_deletion() from authenticated;

drop trigger if exists prepare_restaurant_deletion
  on public.restaurants;
create trigger prepare_restaurant_deletion
before delete on public.restaurants
for each row
execute function public.prepare_restaurant_deletion();

comment on function public.prepare_restaurant_deletion() is
  'Removes tenant-owned rows that intentionally restrict individual wine deletion before the restaurant root cascades.';
