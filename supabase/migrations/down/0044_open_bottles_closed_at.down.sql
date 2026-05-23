-- 0044_open_bottles_closed_at.down.sql

-- Restore original trigger (delete drained rows, no closed_at awareness),
-- drop closed_at column, and restore original record_pour RPC.

create or replace function public.pour_events_maintain_open_bottle()
returns trigger
language plpgsql
as $$
begin
  if NEW.kind = 'new_bottle' then
    insert into public.open_bottles
      (wine_id, restaurant_id, remaining_ml, opened_by)
    values
      (NEW.wine_id, NEW.restaurant_id, -NEW.ml_delta, NEW.actor_user_id)
    on conflict (wine_id, restaurant_id)
    do update set
      remaining_ml = -NEW.ml_delta,
      opened_at = now(),
      opened_by = NEW.actor_user_id;

  elsif NEW.kind in ('pour','spill','finish_bottle') then
    update public.open_bottles
      set remaining_ml = greatest(0, remaining_ml - NEW.ml_delta)
      where wine_id = NEW.wine_id and restaurant_id = NEW.restaurant_id;
    delete from public.open_bottles
      where wine_id = NEW.wine_id and restaurant_id = NEW.restaurant_id
        and remaining_ml = 0;

  elsif NEW.kind = 'reconcile' then
    update public.open_bottles
      set remaining_ml = greatest(0, remaining_ml - NEW.ml_delta)
      where wine_id = NEW.wine_id and restaurant_id = NEW.restaurant_id;
    delete from public.open_bottles
      where wine_id = NEW.wine_id and restaurant_id = NEW.restaurant_id
        and remaining_ml = 0;
  end if;
  return NEW;
end;
$$;

alter table public.open_bottles drop column if exists closed_at;

-- Restore record_pour to pre-0044 version (keeps open_bottle_id from 0038,
-- removes closed_at IS NULL filter from the select).
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
  v_restaurant_id uuid;
  v_size_ml       int;
  v_current       public.open_bottles%rowtype;
  v_sealed_item   public.inventory_items%rowtype;
  v_user          uuid := auth.uid();
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

  select * into v_current
    from public.open_bottles
    where wine_id = p_wine_id and restaurant_id = v_restaurant_id
    for update;

  if not found then
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
  end if;

  if v_current.remaining_ml >= p_ml then
    insert into public.pour_events
      (wine_id, restaurant_id, ml_delta, kind, actor_user_id, note)
    values
      (p_wine_id, v_restaurant_id, p_ml, p_kind, v_user, p_note);
  else
    insert into public.pour_events
      (wine_id, restaurant_id, ml_delta, kind, actor_user_id, note)
    values
      (p_wine_id, v_restaurant_id, v_current.remaining_ml, 'finish_bottle', v_user, p_note);

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

    insert into public.pour_events
      (wine_id, restaurant_id, ml_delta, kind, actor_user_id, note)
    values
      (p_wine_id, v_restaurant_id, p_ml, p_kind, v_user, p_note);
  end if;

  select * into v_current
    from public.open_bottles
    where wine_id = p_wine_id and restaurant_id = v_restaurant_id;
  return v_current;
end;
$$;

grant execute on function public.record_pour(uuid, int, text, text) to authenticated;


-- Restore list_open_bottle_items to not filter on closed_at
create or replace function public.list_open_bottle_items(
  p_restaurant_id uuid
) returns table (
  wine_list_item_id  uuid,
  glass_pour_ml      int,
  pour_size_mode     text,
  wine_id            uuid,
  name               text,
  producer           text,
  vintage            int,
  size_ml            int,
  open_remaining_ml  int,
  opened_at          timestamptz,
  sealed_count       bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    wli.id as wine_list_item_id,
    wli.glass_pour_ml,
    wli.pour_size_mode,
    w.id as wine_id,
    w.name,
    w.producer,
    w.vintage,
    w.size_ml,
    ob.remaining_ml as open_remaining_ml,
    ob.opened_at,
    coalesce((
      select sum(quantity)::bigint from public.inventory_items ii
      where ii.wine_id = w.id and ii.restaurant_id = p_restaurant_id
    ), 0) as sealed_count
  from public.wine_list_items wli
  join public.wine_list_sections s on s.id = wli.section_id
  join public.wine_lists wl        on wl.id = s.wine_list_id
  join public.wines w              on w.id = wli.wine_id
  left join public.open_bottles ob on ob.wine_id = w.id and ob.restaurant_id = p_restaurant_id
  where wl.restaurant_id = p_restaurant_id
    and wli.glass_pour_ml is not null
    and public.is_member(p_restaurant_id)
  order by w.producer, w.name;
$$;

grant execute on function public.list_open_bottle_items(uuid) to authenticated;
