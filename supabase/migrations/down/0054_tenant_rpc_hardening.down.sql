-- Roll back TER-020C tenant/RPC hardening.
-- This restores the pre-0054 callable signatures and relational model.
-- Applying it reopens the security findings fixed by 0054, so use only while
-- rolling the application back to a pre-0054 build.

-- 1. Restore legacy RPC signatures. ------------------------------------------

revoke all on function public.reconcile_open_bottles_batch(uuid, jsonb)
  from public, authenticated;
drop function public.reconcile_open_bottles_batch(uuid, jsonb);

revoke all on function public.reconcile_open_bottle(uuid, uuid, int, text)
  from public, authenticated;
drop function public.reconcile_open_bottle(uuid, uuid, int, text);

revoke all on function public.record_pour(uuid, uuid, int, text, text)
  from public, authenticated;
drop function public.record_pour(uuid, uuid, int, text, text);

revoke all on function public.undo_last_pour(uuid, uuid)
  from public, authenticated;
drop function public.undo_last_pour(uuid, uuid);

revoke all on function public.match_lwin_batch(uuid, uuid[])
  from public, authenticated;
drop function public.match_lwin_batch(uuid, uuid[]);

create or replace function public.match_lwin_batch(p_wine_ids uuid[])
returns table (wine_id uuid, lwin_id text, score float)
language plpgsql
security definer
set search_path = public
as $$
declare
  w record;
  m record;
begin
  for w in
    select id, producer, name, country, region, varietal
    from public.wines
    where id = any(p_wine_ids) and wines.lwin_id is null
  loop
    select * into m from public.match_lwin(w.producer, w.name);
    if m.lwin_id is not null then
      update public.wines set
        lwin_id  = m.lwin_id,
        country  = coalesce(wines.country, m.country),
        region   = coalesce(wines.region, m.region),
        varietal = coalesce(wines.varietal, m.varietal)
      where id = w.id;

      wine_id := w.id;
      lwin_id := m.lwin_id;
      score   := m.score;
      return next;
    end if;
  end loop;
end;
$$;

grant execute on function public.match_lwin_batch(uuid[])
  to public, authenticated;

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

  select * into v_current
    from public.open_bottles
    where wine_id = p_wine_id and restaurant_id = v_restaurant_id
      and closed_at is null
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

  select * into v_current
    from public.open_bottles
    where wine_id = p_wine_id and restaurant_id = v_restaurant_id;
  return v_current;
end;
$$;

grant execute on function public.record_pour(uuid, int, text, text)
  to public, authenticated;

create or replace function public.undo_last_pour(
  p_wine_id uuid
) returns public.open_bottles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_restaurant_id uuid;
  v_event         public.pour_events%rowtype;
  v_current       public.open_bottles%rowtype;
  v_user          uuid := auth.uid();
begin
  select restaurant_id into v_restaurant_id
    from public.wines where id = p_wine_id;
  if v_restaurant_id is null then
    raise exception 'wine not found';
  end if;

  if not public.is_member_with_role(v_restaurant_id, 'staff') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_event
    from public.pour_events
    where wine_id = p_wine_id
      and restaurant_id = v_restaurant_id
      and kind in ('pour', 'spill')
      and open_bottle_id is not null
    order by occurred_at desc
    limit 1
    for update;

  if not found then
    raise exception 'no recent pour to undo';
  end if;

  select * into v_current
    from public.open_bottles
    where wine_id = p_wine_id and restaurant_id = v_restaurant_id
    for update;

  if v_current.id is not null then
    update public.open_bottles
      set remaining_ml = remaining_ml + v_event.ml_delta
      where id = v_current.id;
  else
    insert into public.open_bottles
      (wine_id, restaurant_id, remaining_ml, opened_by)
    values
      (p_wine_id, v_restaurant_id, v_event.ml_delta, v_event.actor_user_id);
  end if;

  delete from public.pour_events
    where id = v_event.id;

  insert into public.availability_events
    (wine_id, restaurant_id, direction, user_id, note)
  values
    (p_wine_id, v_restaurant_id, 'restored', v_user, 'undo pour: ' || v_event.ml_delta || 'ml restored');

  select * into v_current
    from public.open_bottles
    where wine_id = p_wine_id and restaurant_id = v_restaurant_id;
  return v_current;
end;
$$;

grant execute on function public.undo_last_pour(uuid)
  to public, authenticated;

create or replace function public.reconcile_open_bottle(
  p_wine_id          uuid,
  p_new_remaining_ml int,
  p_note             text default null
) returns public.open_bottles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_restaurant_id uuid;
  v_size_ml       int;
  v_current       public.open_bottles%rowtype;
  v_delta         int;
  v_user          uuid := auth.uid();
begin
  if p_new_remaining_ml < 0 then
    raise exception 'p_new_remaining_ml must be >= 0';
  end if;

  select restaurant_id, size_ml into v_restaurant_id, v_size_ml
    from public.wines where id = p_wine_id;
  if v_restaurant_id is null then
    raise exception 'wine not found';
  end if;

  if p_new_remaining_ml > v_size_ml then
    raise exception 'p_new_remaining_ml exceeds bottle size (%)', v_size_ml
      using errcode = 'P0002';
  end if;

  if not public.is_member_with_role(v_restaurant_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_current
    from public.open_bottles
    where wine_id = p_wine_id and restaurant_id = v_restaurant_id
      and closed_at is null
    for update;

  if not found then
    raise exception 'no open bottle for this wine';
  end if;

  v_delta := v_current.remaining_ml - p_new_remaining_ml;

  if v_delta = 0 then
    return v_current;
  end if;

  insert into public.pour_events
    (wine_id, restaurant_id, ml_delta, kind, actor_user_id, note, open_bottle_id)
  values
    (p_wine_id, v_restaurant_id, v_delta, 'reconcile', v_user, p_note, v_current.id);

  insert into public.availability_events
    (wine_id, restaurant_id, direction, delta, user_id, note)
  values
    (p_wine_id, v_restaurant_id, 'reconcile', v_delta, v_user, p_note);

  select * into v_current
    from public.open_bottles
    where wine_id = p_wine_id and restaurant_id = v_restaurant_id;
  return v_current;
end;
$$;

grant execute on function public.reconcile_open_bottle(uuid, int, text)
  to public, authenticated;

create or replace function public.reconcile_open_bottles_batch(
  p_entries jsonb
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry jsonb;
  v_count int := 0;
begin
  if jsonb_typeof(p_entries) <> 'array' then
    raise exception 'p_entries must be a JSON array';
  end if;

  for v_entry in select value from jsonb_array_elements(p_entries)
  loop
    perform public.reconcile_open_bottle(
      (v_entry->>'wine_id')::uuid,
      (v_entry->>'new_remaining_ml')::int,
      v_entry->>'note'
    );
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

grant execute on function public.reconcile_open_bottles_batch(jsonb)
  to public, authenticated;

-- 2. Restore the pre-0054 wine creation helpers. -----------------------------

create or replace function public.find_or_create_wine(
  p_restaurant_id uuid,
  p_name          text,
  p_producer      text,
  p_vintage       int default null,
  p_varietal      text default null,
  p_region        text default null,
  p_country       text default null,
  p_size_ml       int default 750
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  wine_id uuid;
begin
  select id into wine_id
  from public.wines
  where restaurant_id = p_restaurant_id
    and lower(producer) = lower(p_producer)
    and lower(name) = lower(p_name)
    and coalesce(vintage, 0) = coalesce(p_vintage, 0)
    and size_ml = p_size_ml
  limit 1;

  if wine_id is not null then
    update public.wines
    set varietal = coalesce(wines.varietal, p_varietal),
        region = coalesce(wines.region, p_region),
        country = coalesce(wines.country, p_country)
    where id = wine_id
      and (wines.varietal is null or wines.region is null or wines.country is null);
    return wine_id;
  end if;

  insert into public.wines (restaurant_id, name, producer, vintage, varietal, region, country, size_ml)
  values (p_restaurant_id, p_name, p_producer, p_vintage, p_varietal, p_region, p_country, p_size_ml)
  on conflict (restaurant_id, lower(producer), lower(name), coalesce(vintage, 0), size_ml)
  do update set
    varietal = coalesce(excluded.varietal, wines.varietal),
    region = coalesce(excluded.region, wines.region),
    country = coalesce(excluded.country, wines.country)
  returning id into wine_id;

  return wine_id;
end;
$$;

grant execute on function public.find_or_create_wine(uuid, text, text, int, text, text, text, int)
  to public, authenticated;

create or replace function public.find_or_create_wines_batch(
  p_restaurant_id uuid,
  p_wines jsonb
)
returns uuid[]
language plpgsql
security definer
set search_path = public
as $$
declare
  wine_ids uuid[];
  wine_record jsonb;
  wine_id uuid;
  i int;
begin
  wine_ids := array[]::uuid[];

  for i in 0 .. jsonb_array_length(p_wines) - 1 loop
    wine_record := p_wines -> i;

    select w.id into wine_id
    from public.wines w
    where w.restaurant_id = p_restaurant_id
      and lower(w.producer) = lower(wine_record ->> 'producer')
      and lower(w.name) = lower(wine_record ->> 'name')
      and coalesce(w.vintage, 0) = coalesce((wine_record ->> 'vintage')::int, 0)
      and w.size_ml = coalesce((wine_record ->> 'size_ml')::int, 750)
    limit 1;

    if wine_id is not null then
      update public.wines
      set varietal = coalesce(wines.varietal, wine_record ->> 'varietal'),
          region = coalesce(wines.region, wine_record ->> 'region'),
          country = coalesce(wines.country, wine_record ->> 'country')
      where id = wine_id
        and (wines.varietal is null or wines.region is null or wines.country is null);
    else
      insert into public.wines (restaurant_id, name, producer, vintage, varietal, region, country, size_ml)
      values (
        p_restaurant_id,
        wine_record ->> 'name',
        wine_record ->> 'producer',
        (wine_record ->> 'vintage')::int,
        wine_record ->> 'varietal',
        wine_record ->> 'region',
        wine_record ->> 'country',
        coalesce((wine_record ->> 'size_ml')::int, 750)
      )
      on conflict (restaurant_id, lower(producer), lower(name), coalesce(vintage, 0), size_ml)
      do update set
        varietal = coalesce(excluded.varietal, wines.varietal),
        region = coalesce(excluded.region, wines.region),
        country = coalesce(excluded.country, wines.country)
      returning id into wine_id;
    end if;

    wine_ids := wine_ids || wine_id;
  end loop;

  return wine_ids;
end;
$$;

grant execute on function public.find_or_create_wines_batch(uuid, jsonb)
  to public, authenticated;

-- 3. Remove immutable-key and same-tenant enforcement. ----------------------

drop policy "owners and managers can manage invitations"
  on public.invitations;

create policy "owners can manage invitations"
  on public.invitations for all to authenticated
  using (public.is_member_with_role(restaurant_id, 'owner'))
  with check (public.is_member_with_role(restaurant_id, 'owner'));

create policy "managers can read invitations"
  on public.invitations for select to authenticated
  using (public.is_member_with_role(restaurant_id, 'manager'));

drop trigger background_jobs_tenant_key_immutable on public.background_jobs;
drop trigger pour_events_tenant_key_immutable on public.pour_events;
drop trigger open_bottles_tenant_key_immutable on public.open_bottles;
drop trigger availability_events_tenant_key_immutable on public.availability_events;
drop trigger scan_idempotency_tenant_key_immutable on public.scan_idempotency;
drop trigger cellar_config_tenant_key_immutable on public.cellar_config;
drop trigger wine_lists_tenant_key_immutable on public.wine_lists;
drop trigger inventory_items_tenant_key_immutable on public.inventory_items;
drop trigger invoice_scans_tenant_key_immutable on public.invoice_scans;
drop trigger wines_tenant_key_immutable on public.wines;
drop trigger invitations_tenant_key_immutable on public.invitations;
drop trigger memberships_tenant_key_immutable on public.memberships;
drop function public.prevent_tenant_key_update();

drop trigger wine_list_items_enforce_tenant on public.wine_list_items;
drop function public.assert_wine_list_item_tenant();

drop trigger wine_list_sections_parent_key_immutable
  on public.wine_list_sections;
drop function public.prevent_wine_list_section_reparent();

alter table public.pour_events
  drop constraint pour_events_open_bottle_tenant_fkey,
  drop constraint pour_events_wine_tenant_fkey;

alter table public.open_bottles
  drop constraint open_bottles_source_inventory_tenant_fkey,
  drop constraint open_bottles_wine_tenant_fkey;

alter table public.availability_events
  drop constraint availability_events_wine_tenant_fkey;

alter table public.inventory_items
  drop constraint inventory_items_scan_tenant_fkey,
  drop constraint inventory_items_wine_tenant_fkey;

alter table public.inventory_items
  add constraint inventory_items_wine_id_fkey
    foreign key (wine_id) references public.wines(id) on delete restrict,
  add constraint inventory_items_invoice_scan_id_fkey
    foreign key (invoice_scan_id)
    references public.invoice_scans(id)
    on delete set null;

alter table public.availability_events
  add constraint availability_events_wine_id_fkey
    foreign key (wine_id) references public.wines(id) on delete cascade;

alter table public.open_bottles
  add constraint open_bottles_wine_id_fkey
    foreign key (wine_id) references public.wines(id) on delete cascade,
  add constraint open_bottles_source_inventory_item_id_fkey
    foreign key (source_inventory_item_id)
    references public.inventory_items(id)
    on delete set null;

alter table public.pour_events
  add constraint pour_events_wine_id_fkey
    foreign key (wine_id) references public.wines(id) on delete restrict,
  add constraint pour_events_open_bottle_id_fkey
    foreign key (open_bottle_id)
    references public.open_bottles(id)
    on delete set null;

alter table public.open_bottles
  drop constraint open_bottles_id_wine_restaurant_unique;

alter table public.inventory_items
  drop constraint inventory_items_id_wine_restaurant_unique;

alter table public.invoice_scans
  drop constraint invoice_scans_id_restaurant_unique;

alter table public.wines
  drop constraint wines_id_restaurant_unique;

alter function public.list_open_bottle_items(uuid)
  set search_path = public;
grant execute on function public.list_open_bottle_items(uuid) to public;

alter function public.wine_published_list_slugs(uuid, uuid)
  set search_path = public;
grant execute on function public.wine_published_list_slugs(uuid, uuid) to public;
