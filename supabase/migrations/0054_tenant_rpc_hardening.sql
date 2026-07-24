-- TER-020C: make tenant ownership a database invariant and require the
-- caller-selected restaurant on every tenant-sensitive definer RPC.
--
-- This migration intentionally fails before changing the schema when legacy
-- rows violate a new invariant. Cross-tenant data is not safe to guess at or
-- rewrite automatically.

-- 1. Visible preflight for legacy cross-tenant relationships. ----------------

do $$
declare
  v_failures text[] := array[]::text[];
begin
  if exists (
    select 1
    from public.inventory_items item
    join public.wines wine on wine.id = item.wine_id
    where wine.restaurant_id <> item.restaurant_id
  ) then
    v_failures := array_append(v_failures, 'inventory_items.wine_id');
  end if;

  if exists (
    select 1
    from public.inventory_items item
    join public.invoice_scans scan on scan.id = item.invoice_scan_id
    where item.invoice_scan_id is not null
      and scan.restaurant_id <> item.restaurant_id
  ) then
    v_failures := array_append(v_failures, 'inventory_items.invoice_scan_id');
  end if;

  if exists (
    select 1
    from public.wine_list_items item
    join public.wine_list_sections section on section.id = item.section_id
    join public.wine_lists list on list.id = section.wine_list_id
    join public.wines wine on wine.id = item.wine_id
    where wine.restaurant_id <> list.restaurant_id
  ) then
    v_failures := array_append(v_failures, 'wine_list_items.wine_id');
  end if;

  if exists (
    select 1
    from public.availability_events event
    join public.wines wine on wine.id = event.wine_id
    where wine.restaurant_id <> event.restaurant_id
  ) then
    v_failures := array_append(v_failures, 'availability_events.wine_id');
  end if;

  if exists (
    select 1
    from public.open_bottles bottle
    join public.wines wine on wine.id = bottle.wine_id
    where wine.restaurant_id <> bottle.restaurant_id
  ) then
    v_failures := array_append(v_failures, 'open_bottles.wine_id');
  end if;

  if exists (
    select 1
    from public.open_bottles bottle
    join public.inventory_items item
      on item.id = bottle.source_inventory_item_id
    where bottle.source_inventory_item_id is not null
      and (
        item.restaurant_id <> bottle.restaurant_id
        or item.wine_id <> bottle.wine_id
      )
  ) then
    v_failures := array_append(
      v_failures,
      'open_bottles.source_inventory_item_id'
    );
  end if;

  if exists (
    select 1
    from public.pour_events event
    join public.wines wine on wine.id = event.wine_id
    where wine.restaurant_id <> event.restaurant_id
  ) then
    v_failures := array_append(v_failures, 'pour_events.wine_id');
  end if;

  if exists (
    select 1
    from public.pour_events event
    join public.open_bottles bottle on bottle.id = event.open_bottle_id
    where event.open_bottle_id is not null
      and (
        bottle.restaurant_id <> event.restaurant_id
        or bottle.wine_id <> event.wine_id
      )
  ) then
    v_failures := array_append(v_failures, 'pour_events.open_bottle_id');
  end if;

  if cardinality(v_failures) > 0 then
    raise exception using
      errcode = '23514',
      message = 'tenant_hardening_preflight_failed: '
        || array_to_string(v_failures, ', ');
  end if;
end;
$$;

-- 2. Composite keys make same-tenant parentage enforceable by PostgreSQL. ----

alter table public.wines
  add constraint wines_id_restaurant_unique
  unique (id, restaurant_id);

alter table public.invoice_scans
  add constraint invoice_scans_id_restaurant_unique
  unique (id, restaurant_id);

alter table public.inventory_items
  add constraint inventory_items_id_wine_restaurant_unique
  unique (id, wine_id, restaurant_id);

alter table public.open_bottles
  add constraint open_bottles_id_wine_restaurant_unique
  unique (id, wine_id, restaurant_id);

-- Replace the single-column relationships instead of retaining both. Keeping
-- both makes PostgREST embeds ambiguous even though PostgreSQL accepts them.
alter table public.inventory_items
  drop constraint inventory_items_wine_id_fkey,
  drop constraint inventory_items_invoice_scan_id_fkey;

alter table public.availability_events
  drop constraint availability_events_wine_id_fkey;

alter table public.open_bottles
  drop constraint open_bottles_wine_id_fkey,
  drop constraint open_bottles_source_inventory_item_id_fkey;

alter table public.pour_events
  drop constraint pour_events_wine_id_fkey,
  drop constraint pour_events_open_bottle_id_fkey;

alter table public.inventory_items
  add constraint inventory_items_wine_tenant_fkey
  foreign key (wine_id, restaurant_id)
  references public.wines (id, restaurant_id)
  on delete restrict;

alter table public.inventory_items
  add constraint inventory_items_scan_tenant_fkey
  foreign key (invoice_scan_id, restaurant_id)
  references public.invoice_scans (id, restaurant_id)
  on delete set null (invoice_scan_id);

alter table public.availability_events
  add constraint availability_events_wine_tenant_fkey
  foreign key (wine_id, restaurant_id)
  references public.wines (id, restaurant_id)
  on delete cascade;

alter table public.open_bottles
  add constraint open_bottles_wine_tenant_fkey
  foreign key (wine_id, restaurant_id)
  references public.wines (id, restaurant_id)
  on delete cascade;

alter table public.open_bottles
  add constraint open_bottles_source_inventory_tenant_fkey
  foreign key (source_inventory_item_id, wine_id, restaurant_id)
  references public.inventory_items (id, wine_id, restaurant_id)
  on delete set null (source_inventory_item_id);

alter table public.pour_events
  add constraint pour_events_wine_tenant_fkey
  foreign key (wine_id, restaurant_id)
  references public.wines (id, restaurant_id)
  on delete restrict;

alter table public.pour_events
  add constraint pour_events_open_bottle_tenant_fkey
  foreign key (open_bottle_id, wine_id, restaurant_id)
  references public.open_bottles (id, wine_id, restaurant_id)
  on delete set null (open_bottle_id);

-- wine_list_items does not carry restaurant_id. Enforce that its wine and its
-- section's parent list resolve to the same tenant at the relationship seam.
create or replace function public.assert_wine_list_item_tenant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_list_restaurant_id uuid;
  v_wine_restaurant_id uuid;
begin
  select list.restaurant_id
  into v_list_restaurant_id
  from public.wine_list_sections section
  join public.wine_lists list on list.id = section.wine_list_id
  where section.id = new.section_id;

  select wine.restaurant_id
  into v_wine_restaurant_id
  from public.wines wine
  where wine.id = new.wine_id;

  if v_list_restaurant_id is null
     or v_wine_restaurant_id is null
     or v_list_restaurant_id <> v_wine_restaurant_id then
    raise exception using
      errcode = '23514',
      message = 'wine_list_item_tenant_mismatch';
  end if;

  return new;
end;
$$;

revoke all on function public.assert_wine_list_item_tenant() from public;

create trigger wine_list_items_enforce_tenant
  before insert or update of section_id, wine_id
  on public.wine_list_items
  for each row
  execute function public.assert_wine_list_item_tenant();

-- Reparenting a populated section could bypass the item trigger and move its
-- wines under a different tenant's list. Sections are ownership-scoped
-- children; callers can copy/delete when they intentionally move content.
create or replace function public.prevent_wine_list_section_reparent()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.wine_list_id is distinct from old.wine_list_id then
    raise exception using
      errcode = '23514',
      message = 'wine_list_sections.wine_list_id is immutable';
  end if;

  return new;
end;
$$;

revoke all on function public.prevent_wine_list_section_reparent() from public;

create trigger wine_list_sections_parent_key_immutable
  before update of wine_list_id on public.wine_list_sections
  for each row execute function public.prevent_wine_list_section_reparent();

-- 3. A row cannot be reassigned between tenants after creation. -------------

create or replace function public.prevent_tenant_key_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.restaurant_id is distinct from old.restaurant_id then
    raise exception using
      errcode = '23514',
      message = tg_table_name || '.restaurant_id is immutable';
  end if;

  return new;
end;
$$;

revoke all on function public.prevent_tenant_key_update() from public;

create trigger memberships_tenant_key_immutable
  before update of restaurant_id on public.memberships
  for each row execute function public.prevent_tenant_key_update();

create trigger invitations_tenant_key_immutable
  before update of restaurant_id on public.invitations
  for each row execute function public.prevent_tenant_key_update();

create trigger wines_tenant_key_immutable
  before update of restaurant_id on public.wines
  for each row execute function public.prevent_tenant_key_update();

create trigger invoice_scans_tenant_key_immutable
  before update of restaurant_id on public.invoice_scans
  for each row execute function public.prevent_tenant_key_update();

create trigger inventory_items_tenant_key_immutable
  before update of restaurant_id on public.inventory_items
  for each row execute function public.prevent_tenant_key_update();

create trigger wine_lists_tenant_key_immutable
  before update of restaurant_id on public.wine_lists
  for each row execute function public.prevent_tenant_key_update();

create trigger cellar_config_tenant_key_immutable
  before update of restaurant_id on public.cellar_config
  for each row execute function public.prevent_tenant_key_update();

create trigger scan_idempotency_tenant_key_immutable
  before update of restaurant_id on public.scan_idempotency
  for each row execute function public.prevent_tenant_key_update();

create trigger availability_events_tenant_key_immutable
  before update of restaurant_id on public.availability_events
  for each row execute function public.prevent_tenant_key_update();

create trigger open_bottles_tenant_key_immutable
  before update of restaurant_id on public.open_bottles
  for each row execute function public.prevent_tenant_key_update();

create trigger pour_events_tenant_key_immutable
  before update of restaurant_id on public.pour_events
  for each row execute function public.prevent_tenant_key_update();

create trigger background_jobs_tenant_key_immutable
  before update of restaurant_id on public.background_jobs
  for each row execute function public.prevent_tenant_key_update();

-- 4. Owners and managers share the invitation lifecycle. --------------------

drop policy "owners can manage invitations" on public.invitations;
drop policy "managers can read invitations" on public.invitations;

create policy "owners and managers can manage invitations"
  on public.invitations for all to authenticated
  using (public.is_member_with_role(restaurant_id, 'manager'))
  with check (public.is_member_with_role(restaurant_id, 'manager'));

-- 5. Definer wine creation/enrichment RPCs must authenticate the tenant. -----

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
set search_path = ''
as $$
declare
  wine_id uuid;
begin
  if not public.is_member_with_role(p_restaurant_id, 'staff') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

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
      and restaurant_id = p_restaurant_id
      and (
        wines.varietal is null
        or wines.region is null
        or wines.country is null
      );
    return wine_id;
  end if;

  insert into public.wines (
    restaurant_id,
    name,
    producer,
    vintage,
    varietal,
    region,
    country,
    size_ml
  )
  values (
    p_restaurant_id,
    p_name,
    p_producer,
    p_vintage,
    p_varietal,
    p_region,
    p_country,
    p_size_ml
  )
  on conflict (
    restaurant_id,
    lower(producer),
    lower(name),
    coalesce(vintage, 0),
    size_ml
  )
  do update set
    varietal = coalesce(excluded.varietal, wines.varietal),
    region = coalesce(excluded.region, wines.region),
    country = coalesce(excluded.country, wines.country)
  returning id into wine_id;

  return wine_id;
end;
$$;

revoke all on function public.find_or_create_wine(uuid, text, text, int, text, text, text, int) from public;
grant execute on function public.find_or_create_wine(uuid, text, text, int, text, text, text, int) to authenticated;

create or replace function public.find_or_create_wines_batch(
  p_restaurant_id uuid,
  p_wines         jsonb
)
returns uuid[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  wine_ids uuid[] := array[]::uuid[];
  wine_record jsonb;
  wine_id uuid;
  i int;
begin
  if not public.is_member_with_role(p_restaurant_id, 'staff') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if jsonb_typeof(p_wines) <> 'array' then
    raise exception 'p_wines must be a JSON array' using errcode = '22023';
  end if;

  if jsonb_array_length(p_wines) = 0 then
    return wine_ids;
  end if;

  for i in 0 .. jsonb_array_length(p_wines) - 1 loop
    wine_record := p_wines -> i;
    wine_id := null;

    select w.id into wine_id
    from public.wines w
    where w.restaurant_id = p_restaurant_id
      and lower(w.producer) = lower(wine_record ->> 'producer')
      and lower(w.name) = lower(wine_record ->> 'name')
      and coalesce(w.vintage, 0) =
        coalesce((wine_record ->> 'vintage')::int, 0)
      and w.size_ml = coalesce((wine_record ->> 'size_ml')::int, 750)
    limit 1;

    if wine_id is not null then
      update public.wines
      set varietal = coalesce(wines.varietal, wine_record ->> 'varietal'),
          region = coalesce(wines.region, wine_record ->> 'region'),
          country = coalesce(wines.country, wine_record ->> 'country')
      where id = wine_id
        and restaurant_id = p_restaurant_id
        and (
          wines.varietal is null
          or wines.region is null
          or wines.country is null
        );
    else
      insert into public.wines (
        restaurant_id,
        name,
        producer,
        vintage,
        varietal,
        region,
        country,
        size_ml
      )
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
      on conflict (
        restaurant_id,
        lower(producer),
        lower(name),
        coalesce(vintage, 0),
        size_ml
      )
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

revoke all on function public.find_or_create_wines_batch(uuid, jsonb) from public;
grant execute on function public.find_or_create_wines_batch(uuid, jsonb) to authenticated;

revoke all on function public.match_lwin_batch(uuid[]) from public;
revoke all on function public.match_lwin_batch(uuid[]) from authenticated;
drop function public.match_lwin_batch(uuid[]);

create or replace function public.match_lwin_batch(
  p_restaurant_id uuid,
  p_wine_ids uuid[]
)
returns table (wine_id uuid, lwin_id text, score float)
language plpgsql
security definer
set search_path = ''
as $$
declare
  w record;
  m record;
begin
  if not public.is_member_with_role(p_restaurant_id, 'staff') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if exists (
    select 1
    from unnest(p_wine_ids) requested(wine_id)
    left join public.wines
      on wines.id = requested.wine_id
      and wines.restaurant_id = p_restaurant_id
    where wines.id is null
  ) then
    raise exception 'wine not found' using errcode = 'P0001';
  end if;

  for w in
    select
      wines.id,
      wines.producer,
      wines.name,
      wines.country,
      wines.region,
      wines.varietal
    from public.wines
    where wines.restaurant_id = p_restaurant_id
      and wines.id = any(p_wine_ids)
      and wines.lwin_id is null
  loop
    select * into m from public.match_lwin(w.producer, w.name);
    if m.lwin_id is not null then
      update public.wines
      set lwin_id = m.lwin_id,
          country = coalesce(wines.country, m.country),
          region = coalesce(wines.region, m.region),
          varietal = coalesce(wines.varietal, m.varietal)
      where id = w.id
        and restaurant_id = p_restaurant_id;

      wine_id := w.id;
      lwin_id := m.lwin_id;
      score := m.score;
      return next;
    end if;
  end loop;
end;
$$;

revoke all on function public.match_lwin_batch(uuid, uuid[]) from public;
grant execute on function public.match_lwin_batch(uuid, uuid[]) to authenticated;

-- 6. Pour/reconcile RPCs require and enforce the active restaurant. ---------

revoke all on function public.reconcile_open_bottles_batch(jsonb) from public;
revoke all on function public.reconcile_open_bottles_batch(jsonb) from authenticated;
drop function public.reconcile_open_bottles_batch(jsonb);

revoke all on function public.reconcile_open_bottle(uuid, int, text) from public;
revoke all on function public.reconcile_open_bottle(uuid, int, text) from authenticated;
drop function public.reconcile_open_bottle(uuid, int, text);

revoke all on function public.record_pour(uuid, int, text, text) from public;
revoke all on function public.record_pour(uuid, int, text, text) from authenticated;
drop function public.record_pour(uuid, int, text, text);

revoke all on function public.undo_last_pour(uuid) from public;
revoke all on function public.undo_last_pour(uuid) from authenticated;
drop function public.undo_last_pour(uuid);

create or replace function public.record_pour(
  p_restaurant_id uuid,
  p_wine_id uuid,
  p_ml int,
  p_kind text default 'pour',
  p_note text default null
) returns public.open_bottles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_size_ml int;
  v_current public.open_bottles%rowtype;
  v_open_bottle_id uuid;
  v_sealed_item public.inventory_items%rowtype;
  v_user uuid := auth.uid();
begin
  if not public.is_member_with_role(p_restaurant_id, 'staff') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_ml is null or p_ml <= 0 then
    raise exception 'p_ml must be positive';
  end if;
  if p_kind not in ('pour', 'spill') then
    raise exception 'p_kind must be pour or spill';
  end if;

  select size_ml into v_size_ml
  from public.wines
  where id = p_wine_id
    and restaurant_id = p_restaurant_id;
  if not found then
    raise exception 'wine not found' using errcode = 'P0001';
  end if;

  select * into v_current
  from public.open_bottles
  where wine_id = p_wine_id
    and restaurant_id = p_restaurant_id
    and closed_at is null
  for update;

  if not found then
    select * into v_sealed_item
    from public.inventory_items
    where wine_id = p_wine_id
      and restaurant_id = p_restaurant_id
      and quantity > 0
    order by added_at asc
    limit 1
    for update skip locked;

    if not found then
      raise exception 'TERROIR_OUT_OF_STOCK' using errcode = 'P0001';
    end if;

    update public.inventory_items
    set quantity = quantity - 1
    where id = v_sealed_item.id
      and restaurant_id = p_restaurant_id;

    insert into public.pour_events (
      wine_id,
      restaurant_id,
      ml_delta,
      kind,
      actor_user_id,
      note
    )
    values (
      p_wine_id,
      p_restaurant_id,
      -v_size_ml,
      'new_bottle',
      v_user,
      p_note
    );

    select * into v_current
    from public.open_bottles
    where wine_id = p_wine_id
      and restaurant_id = p_restaurant_id;

    v_open_bottle_id := v_current.id;
  else
    v_open_bottle_id := v_current.id;
  end if;

  if v_current.remaining_ml >= p_ml then
    insert into public.pour_events (
      wine_id,
      restaurant_id,
      ml_delta,
      kind,
      actor_user_id,
      note,
      open_bottle_id
    )
    values (
      p_wine_id,
      p_restaurant_id,
      p_ml,
      p_kind,
      v_user,
      p_note,
      v_open_bottle_id
    );
  else
    insert into public.pour_events (
      wine_id,
      restaurant_id,
      ml_delta,
      kind,
      actor_user_id,
      note,
      open_bottle_id
    )
    values (
      p_wine_id,
      p_restaurant_id,
      v_current.remaining_ml,
      'finish_bottle',
      v_user,
      p_note,
      v_open_bottle_id
    );

    select * into v_sealed_item
    from public.inventory_items
    where wine_id = p_wine_id
      and restaurant_id = p_restaurant_id
      and quantity > 0
    order by added_at asc
    limit 1
    for update skip locked;

    if not found then
      raise exception 'TERROIR_OUT_OF_STOCK' using errcode = 'P0001';
    end if;

    update public.inventory_items
    set quantity = quantity - 1
    where id = v_sealed_item.id
      and restaurant_id = p_restaurant_id;

    insert into public.pour_events (
      wine_id,
      restaurant_id,
      ml_delta,
      kind,
      actor_user_id,
      note
    )
    values (
      p_wine_id,
      p_restaurant_id,
      -v_size_ml,
      'new_bottle',
      v_user,
      p_note
    );

    select * into v_current
    from public.open_bottles
    where wine_id = p_wine_id
      and restaurant_id = p_restaurant_id;

    insert into public.pour_events (
      wine_id,
      restaurant_id,
      ml_delta,
      kind,
      actor_user_id,
      note,
      open_bottle_id
    )
    values (
      p_wine_id,
      p_restaurant_id,
      p_ml,
      p_kind,
      v_user,
      p_note,
      v_current.id
    );
  end if;

  select * into v_current
  from public.open_bottles
  where wine_id = p_wine_id
    and restaurant_id = p_restaurant_id;
  return v_current;
end;
$$;

revoke all on function public.record_pour(uuid, uuid, int, text, text) from public;
grant execute on function public.record_pour(uuid, uuid, int, text, text) to authenticated;

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

create or replace function public.reconcile_open_bottle(
  p_restaurant_id uuid,
  p_wine_id uuid,
  p_new_remaining_ml int,
  p_note text default null
) returns public.open_bottles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_size_ml int;
  v_current public.open_bottles%rowtype;
  v_delta int;
  v_user uuid := auth.uid();
begin
  if not public.is_member_with_role(p_restaurant_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_new_remaining_ml < 0 then
    raise exception 'p_new_remaining_ml must be >= 0';
  end if;

  select size_ml into v_size_ml
  from public.wines
  where id = p_wine_id
    and restaurant_id = p_restaurant_id;
  if not found then
    raise exception 'wine not found' using errcode = 'P0001';
  end if;

  if p_new_remaining_ml > v_size_ml then
    raise exception 'p_new_remaining_ml exceeds bottle size (%)', v_size_ml
      using errcode = 'P0002';
  end if;

  select * into v_current
  from public.open_bottles
  where wine_id = p_wine_id
    and restaurant_id = p_restaurant_id
    and closed_at is null
  for update;

  if not found then
    raise exception 'no open bottle for this wine' using errcode = 'P0001';
  end if;

  v_delta := v_current.remaining_ml - p_new_remaining_ml;

  if v_delta = 0 then
    return v_current;
  end if;

  insert into public.pour_events (
    wine_id,
    restaurant_id,
    ml_delta,
    kind,
    actor_user_id,
    note,
    open_bottle_id
  )
  values (
    p_wine_id,
    p_restaurant_id,
    v_delta,
    'reconcile',
    v_user,
    p_note,
    v_current.id
  );

  insert into public.availability_events (
    wine_id,
    restaurant_id,
    direction,
    delta,
    user_id,
    note
  )
  values (
    p_wine_id,
    p_restaurant_id,
    'reconcile',
    v_delta,
    v_user,
    p_note
  );

  select * into v_current
  from public.open_bottles
  where wine_id = p_wine_id
    and restaurant_id = p_restaurant_id;
  return v_current;
end;
$$;

revoke all on function public.reconcile_open_bottle(uuid, uuid, int, text) from public;
grant execute on function public.reconcile_open_bottle(uuid, uuid, int, text) to authenticated;

create or replace function public.reconcile_open_bottles_batch(
  p_restaurant_id uuid,
  p_entries jsonb
) returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry jsonb;
  v_count int := 0;
begin
  if not public.is_member_with_role(p_restaurant_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if jsonb_typeof(p_entries) <> 'array' then
    raise exception 'p_entries must be a JSON array';
  end if;

  for v_entry in select value from jsonb_array_elements(p_entries)
  loop
    perform public.reconcile_open_bottle(
      p_restaurant_id,
      (v_entry ->> 'wine_id')::uuid,
      (v_entry ->> 'new_remaining_ml')::int,
      v_entry ->> 'note'
    );
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.reconcile_open_bottles_batch(uuid, jsonb) from public;
grant execute on function public.reconcile_open_bottles_batch(uuid, jsonb) to authenticated;

-- Existing read helpers remain API-compatible but must not inherit PostgreSQL's
-- default PUBLIC execute privilege.
alter function public.list_open_bottle_items(uuid)
  set search_path = '';
revoke all on function public.list_open_bottle_items(uuid) from public;
grant execute on function public.list_open_bottle_items(uuid) to authenticated;

alter function public.wine_published_list_slugs(uuid, uuid)
  set search_path = '';
revoke all on function public.wine_published_list_slugs(uuid, uuid) from public;
grant execute on function public.wine_published_list_slugs(uuid, uuid) to authenticated;

comment on function public.record_pour(uuid, uuid, int, text, text) is
  'Records a pour only within the explicitly selected, authenticated restaurant.';
comment on function public.undo_last_pour(uuid, uuid) is
  'Undoes the latest pour only within the explicitly selected, authenticated restaurant.';
comment on function public.reconcile_open_bottle(uuid, uuid, int, text) is
  'Reconciles an open bottle only within the explicitly selected manager restaurant.';
comment on function public.reconcile_open_bottles_batch(uuid, jsonb) is
  'Atomically reconciles entries within one explicitly selected manager restaurant.';
