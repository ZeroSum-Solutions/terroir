-- 0061_close_open_bottle.sql
-- OPP-10 verify finding V1: closing a bottle was two separate writes
-- (bottle_closeouts insert, then the finish_bottle pour event) with a
-- best-effort delete as rollback — a partial failure could record a
-- close-out while the bottle stayed open. This RPC makes the close-out
-- one transaction: validate, insert the closeout, and emit the
-- finish_bottle event (the pour_events trigger drains and removes the
-- open_bottles row in the same transaction).

create or replace function public.close_open_bottle(
  p_wine_id                  uuid,
  p_actual_remaining_ml      int,
  p_written_off_ml           int default 0,
  p_reason_code_id           uuid default null
) returns public.bottle_closeouts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_restaurant_id uuid;
  v_bottle        public.open_bottles%rowtype;
  v_size_ml       int;
  v_theoretical   int;
  v_closeout      public.bottle_closeouts%rowtype;
begin
  -- Same authority pattern as record_pour: the wine names the tenant,
  -- membership is then verified against it.
  select restaurant_id, size_ml into v_restaurant_id, v_size_ml
    from public.wines where id = p_wine_id;
  if v_restaurant_id is null then
    raise exception 'wine_not_found';
  end if;
  if not public.is_member_with_role(v_restaurant_id, 'staff') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_bottle
    from public.open_bottles
   where wine_id = p_wine_id and restaurant_id = v_restaurant_id
     and closed_at is null
   for update;
  if not found then
    raise exception 'open_bottle_not_found';
  end if;

  if v_size_ml is null then
    raise exception 'wine_size_unknown';
  end if;

  if p_actual_remaining_ml < 0 or p_actual_remaining_ml > v_size_ml then
    raise exception 'invalid_actual_remaining';
  end if;
  -- You can only write off liquid that is physically in the bottle.
  if p_written_off_ml < 0 or p_written_off_ml > p_actual_remaining_ml then
    raise exception 'invalid_writeoff_amount';
  end if;
  if p_written_off_ml > 0 then
    if p_reason_code_id is null then
      raise exception 'writeoff_reason_required';
    end if;
    perform 1 from public.reason_codes rc
      where rc.id = p_reason_code_id
        and rc.restaurant_id = v_restaurant_id
        and rc.active
        and rc.category in ('spoilage', 'adjustment');
    if not found then
      raise exception 'invalid_reason_code';
    end if;
  end if;

  v_theoretical := v_bottle.remaining_ml;

  insert into public.bottle_closeouts (
    restaurant_id, wine_id, open_bottle_id, preservation_method,
    opened_at, closed_by, theoretical_remaining_ml, actual_remaining_ml,
    written_off_ml, reason_code_id
  ) values (
    v_restaurant_id, p_wine_id, v_bottle.id, v_bottle.preservation_method,
    v_bottle.opened_at, auth.uid(), v_theoretical, p_actual_remaining_ml,
    p_written_off_ml, p_reason_code_id
  ) returning * into v_closeout;

  -- Finish event: the pour_events trigger drains remaining_ml to zero and
  -- deletes the open_bottles row inside this same transaction.
  insert into public.pour_events (
    wine_id, restaurant_id, open_bottle_id, ml_delta, kind, actor_user_id, note
  ) values (
    p_wine_id, v_restaurant_id, v_bottle.id, v_bottle.remaining_ml, 'finish_bottle',
    auth.uid(), 'Bottle close-out'
  );

  return v_closeout;
end;
$$;

revoke execute on function public.close_open_bottle(uuid, int, int, uuid) from public, anon;
grant execute on function public.close_open_bottle(uuid, int, int, uuid) to authenticated;
