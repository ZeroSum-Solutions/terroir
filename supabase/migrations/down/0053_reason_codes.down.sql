-- 0053_reason_codes.down.sql

-- Restore handle_new_user to its 0001_auth_boundary.sql definition.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_restaurant_id uuid;
  restaurant_name   text;
begin
  restaurant_name := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'restaurant_name'), ''),
    'My Restaurant'
  );

  insert into public.restaurants (name)
  values (restaurant_name)
  returning id into new_restaurant_id;

  insert into public.memberships (user_id, restaurant_id, role)
  values (new.id, new_restaurant_id, 'owner');

  return new;
end;
$$;

drop function if exists public.seed_reason_codes(uuid);

drop policy if exists "managers can update reason_codes" on public.reason_codes;
drop policy if exists "managers can insert reason_codes" on public.reason_codes;
drop policy if exists "members can read reason_codes" on public.reason_codes;

drop table if exists public.reason_codes;
