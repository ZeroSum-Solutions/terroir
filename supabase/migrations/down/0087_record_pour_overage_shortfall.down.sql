-- Reverse of 0087_record_pour_overage_shortfall.sql
-- Restores record_pour to its exact pre-fix (0044) body.

create or replace function public.record_pour(
  p_wine_id uuid,
  p_ml      int,
  p_kind    text default 'pour',
  p_note    text default null
) returns public.open_bottles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_restaurant_id  uuid;
  v_size_ml        int;
  v_current        public.open_bottles%rowtype;
  v_open_bottle_id uuid;
  v_sealed_item    public.inventory_items%rowtype;
  v_user           uuid := auth.uid();
begin
  if p_ml is null or p_ml <= 0 then
    raise exception 'p_ml must be positive';
  end if;
  if p_kind not in ('pour','spill') then
    raise exception 'p_kind must be pour or spill';
  end if;

  select restaurant_id, size_ml into v_restaurant_id, v_size_ml
    from public.wines where id = p_wine_id;
  if v_restaurant_id is null then
    raise exception 'wine not found';
  end if;

  if not public.is_member_with_role(v_restaurant_id, 'staff') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Only consider active (non-closed) bottles.
  select * into v_current
    from public.open_bottles
    where wine_id = p_wine_id and restaurant_id = v_restaurant_id
      and closed_at is null
    for update;

  if not found then
    -- No open bottle: need to open one from sealed stock.
    select * into v_sealed_item
      from public.inventory_items
      where wine_id = p_wine_id
        and restaurant_id = v_restaurant_id
        and quantity > 0
      order by added_at asc
      limit 1
      for update skip locked;

    if not found then
      raise exception 'TERROIR_OUT_OF_STOCK' using errcode = 'P0001';
    end if;

    update public.inventory_items
      set quantity = quantity - 1
      where id = v_sealed_item.id;

    insert into public.pour_events
      (wine_id, restaurant_id, ml_delta, kind, actor_user_id, note)
    values
      (p_wine_id, v_restaurant_id, -v_size_ml, 'new_bottle', v_user, p_note);

    select * into v_current
      from public.open_bottles
      where wine_id = p_wine_id and restaurant_id = v_restaurant_id;

    v_open_bottle_id := v_current.id;
  else
    v_open_bottle_id := v_current.id;
  end if;

  if v_current.remaining_ml >= p_ml then
    insert into public.pour_events
      (wine_id, restaurant_id, ml_delta, kind, actor_user_id, note, open_bottle_id)
    values
      (p_wine_id, v_restaurant_id, p_ml, p_kind, v_user, p_note, v_open_bottle_id);
  else
    -- Overage: finish current, open next, pour the full amount.
    insert into public.pour_events
      (wine_id, restaurant_id, ml_delta, kind, actor_user_id, note, open_bottle_id)
    values
      (p_wine_id, v_restaurant_id, v_current.remaining_ml, 'finish_bottle', v_user, p_note, v_open_bottle_id);

    select * into v_sealed_item
      from public.inventory_items
      where wine_id = p_wine_id
        and restaurant_id = v_restaurant_id
        and quantity > 0
      order by added_at asc
      limit 1
      for update skip locked;

    if not found then
      -- We finished the bottle but have no replacement.
      raise exception 'TERROIR_OUT_OF_STOCK' using errcode = 'P0001';
    end if;

    update public.inventory_items
      set quantity = quantity - 1
      where id = v_sealed_item.id;

    insert into public.pour_events
      (wine_id, restaurant_id, ml_delta, kind, actor_user_id, note)
    values
      (p_wine_id, v_restaurant_id, -v_size_ml, 'new_bottle', v_user, p_note);

    select * into v_current
      from public.open_bottles
      where wine_id = p_wine_id and restaurant_id = v_restaurant_id;

    insert into public.pour_events
      (wine_id, restaurant_id, ml_delta, kind, actor_user_id, note, open_bottle_id)
    values
      (p_wine_id, v_restaurant_id, p_ml, p_kind, v_user, p_note, v_current.id);
  end if;

  -- Return the (possibly new) open_bottles row.
  select * into v_current
    from public.open_bottles
    where wine_id = p_wine_id and restaurant_id = v_restaurant_id;
  return v_current;
end;
$$;

grant execute on function public.record_pour(uuid, int, text, text) to authenticated;
