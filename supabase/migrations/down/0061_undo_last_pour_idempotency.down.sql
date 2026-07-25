-- Reverse of 0061_undo_last_pour_idempotency.sql.

drop function if exists public.undo_last_pour_idempotent(
  uuid,
  uuid,
  text,
  text
);

-- Restore the 0054 implementation verbatim. The forward migration removes
-- its duplicate remaining_ml restoration.
create or replace function public.undo_last_pour(
  p_restaurant_id uuid,
  p_wine_id uuid
) returns public.open_bottles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.pour_events%rowtype;
  v_current public.open_bottles%rowtype;
  v_user uuid := auth.uid();
begin
  if not public.is_member_with_role(p_restaurant_id, 'staff') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  perform 1
  from public.wines
  where id = p_wine_id
    and restaurant_id = p_restaurant_id;
  if not found then
    raise exception 'wine not found' using errcode = 'P0001';
  end if;

  select * into v_event
  from public.pour_events
  where wine_id = p_wine_id
    and restaurant_id = p_restaurant_id
    and kind in ('pour', 'spill')
    and open_bottle_id is not null
  order by occurred_at desc
  limit 1
  for update;

  if not found then
    raise exception 'no recent pour to undo' using errcode = 'P0001';
  end if;

  select * into v_current
  from public.open_bottles
  where wine_id = p_wine_id
    and restaurant_id = p_restaurant_id
  for update;

  if v_current.id is not null then
    update public.open_bottles
    set remaining_ml = remaining_ml + v_event.ml_delta
    where id = v_current.id
      and restaurant_id = p_restaurant_id;
  else
    insert into public.open_bottles (
      wine_id,
      restaurant_id,
      remaining_ml,
      opened_by
    )
    values (
      p_wine_id,
      p_restaurant_id,
      v_event.ml_delta,
      v_event.actor_user_id
    );
  end if;

  delete from public.pour_events
  where id = v_event.id
    and restaurant_id = p_restaurant_id;

  insert into public.availability_events (
    wine_id,
    restaurant_id,
    direction,
    user_id,
    note
  )
  values (
    p_wine_id,
    p_restaurant_id,
    'restored',
    v_user,
    'undo pour: ' || v_event.ml_delta || 'ml restored'
  );

  select * into v_current
  from public.open_bottles
  where wine_id = p_wine_id
    and restaurant_id = p_restaurant_id;
  return v_current;
end;
$$;

revoke all on function public.undo_last_pour(uuid, uuid) from public;
grant execute on function public.undo_last_pour(uuid, uuid) to authenticated;
