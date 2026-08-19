-- === 0001_auth_boundary.sql ===
-- 0001_auth_boundary.sql
-- Auth-boundary schema: restaurants + memberships + RLS + signup trigger.
-- Wines, invoices, wine_lists, etc. arrive in a later migration once the
-- Phase 1 scanner has validated the data model against real invoices.

-------------------------------------------------------------------------------
-- Helpers
-------------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-------------------------------------------------------------------------------
-- restaurants
-------------------------------------------------------------------------------
create table public.restaurants (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null default 'My Restaurant',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger restaurants_set_updated_at
  before update on public.restaurants
  for each row execute function public.set_updated_at();

alter table public.restaurants enable row level security;

-------------------------------------------------------------------------------
-- memberships
-------------------------------------------------------------------------------
create type public.membership_role as enum ('owner', 'manager', 'staff');

create table public.memberships (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id)        on delete cascade,
  restaurant_id  uuid not null references public.restaurants(id) on delete cascade,
  role           public.membership_role not null default 'owner',
  created_at     timestamptz not null default now(),
  unique (user_id, restaurant_id)
);

create index memberships_user_id_idx       on public.memberships (user_id);
create index memberships_restaurant_id_idx on public.memberships (restaurant_id);

alter table public.memberships enable row level security;

-------------------------------------------------------------------------------
-- Membership-lookup helper (SECURITY DEFINER — avoids RLS recursion)
-------------------------------------------------------------------------------
create or replace function public.is_member(r_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.memberships
    where user_id = auth.uid() and restaurant_id = r_id
  );
$$;

create or replace function public.is_member_with_role(r_id uuid, required public.membership_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.memberships
    where user_id = auth.uid()
      and restaurant_id = r_id
      and (
        role = required
        or (required = 'manager' and role = 'owner')
        or (required = 'staff'   and role in ('owner', 'manager'))
      )
  );
$$;

revoke all on function public.is_member(uuid)                               from public;
revoke all on function public.is_member_with_role(uuid, public.membership_role) from public;
grant execute on function public.is_member(uuid)                               to authenticated;
grant execute on function public.is_member_with_role(uuid, public.membership_role) to authenticated;

-------------------------------------------------------------------------------
-- RLS policies: restaurants
-------------------------------------------------------------------------------
create policy "members can read their restaurants"
  on public.restaurants for select
  to authenticated
  using (public.is_member(id));

create policy "owners and managers can update their restaurants"
  on public.restaurants for update
  to authenticated
  using      (public.is_member_with_role(id, 'manager'))
  with check (public.is_member_with_role(id, 'manager'));

-- INSERT / DELETE intentionally unrestricted by policy (no policy = deny).
-- Creation happens via the signup trigger; deletion requires service role.

-------------------------------------------------------------------------------
-- RLS policies: memberships
-------------------------------------------------------------------------------
create policy "users can read memberships in their restaurants"
  on public.memberships for select
  to authenticated
  using (user_id = auth.uid() or public.is_member(restaurant_id));

create policy "owners can manage memberships in their restaurant"
  on public.memberships for all
  to authenticated
  using      (public.is_member_with_role(restaurant_id, 'owner'))
  with check (public.is_member_with_role(restaurant_id, 'owner'));

-------------------------------------------------------------------------------
-- Signup trigger: on new auth.users, provision a restaurant + owner membership
-------------------------------------------------------------------------------
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

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- === 0002_phase2_schema.sql ===
-- 0002_phase2_schema.sql
-- Phase 2 schema: wines, invoice_scans, inventory_items, wine_lists,
-- wine_list_sections, wine_list_items. All restaurant-scoped via RLS
-- using the is_member() helper from 0001_auth_boundary.sql.

-------------------------------------------------------------------------------
-- wines — canonical wine catalog, restaurant-scoped
-------------------------------------------------------------------------------
create table public.wines (
  id             uuid        primary key default gen_random_uuid(),
  restaurant_id  uuid        not null references public.restaurants(id) on delete cascade,
  name           text        not null,
  producer       text        not null,
  vintage        int,
  varietal       text,
  region         text,
  country        text,
  size_ml        int         not null default 750,
  lwin_id        text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create unique index wines_dedup_idx
  on public.wines (restaurant_id, lower(producer), lower(name), coalesce(vintage, 0), size_ml);

create index wines_restaurant_id_idx on public.wines (restaurant_id);

create trigger wines_set_updated_at
  before update on public.wines
  for each row execute function public.set_updated_at();

alter table public.wines enable row level security;

create policy "members can read their wines"
  on public.wines for select to authenticated
  using (public.is_member(restaurant_id));

create policy "members can insert wines"
  on public.wines for insert to authenticated
  with check (public.is_member(restaurant_id));

create policy "members can update their wines"
  on public.wines for update to authenticated
  using (public.is_member(restaurant_id))
  with check (public.is_member(restaurant_id));

create policy "members can delete their wines"
  on public.wines for delete to authenticated
  using (public.is_member(restaurant_id));

-------------------------------------------------------------------------------
-- invoice_scans — persisted scan audit trail
-------------------------------------------------------------------------------
create table public.invoice_scans (
  id                uuid        primary key default gen_random_uuid(),
  restaurant_id     uuid        not null references public.restaurants(id) on delete cascade,
  distributor_name  text        not null,
  invoice_number    text,
  invoice_date      date,
  raw_image_path    text,
  parsed_line_items jsonb       not null,
  final_line_items  jsonb       not null,
  edits             jsonb       not null default '{}',
  accuracy_score    real,
  item_count        int         not null default 0,
  created_at        timestamptz not null default now()
);

create index invoice_scans_restaurant_id_idx
  on public.invoice_scans (restaurant_id);
create index invoice_scans_created_at_idx
  on public.invoice_scans (restaurant_id, created_at desc);

alter table public.invoice_scans enable row level security;

create policy "members can read their scans"
  on public.invoice_scans for select to authenticated
  using (public.is_member(restaurant_id));

create policy "members can insert scans"
  on public.invoice_scans for insert to authenticated
  with check (public.is_member(restaurant_id));

-------------------------------------------------------------------------------
-- added_via enum
-------------------------------------------------------------------------------
create type public.added_via as enum ('manual', 'invoice_scan');

-------------------------------------------------------------------------------
-- inventory_items — per-receipt wine stock
-------------------------------------------------------------------------------
create table public.inventory_items (
  id                uuid        primary key default gen_random_uuid(),
  wine_id           uuid        not null references public.wines(id) on delete restrict,
  restaurant_id     uuid        not null references public.restaurants(id) on delete cascade,
  invoice_scan_id   uuid        references public.invoice_scans(id) on delete set null,
  quantity          int         not null check (quantity >= 0),
  unit_cost         numeric(10,2) not null check (unit_cost >= 0),
  bin_location      text,
  added_via         public.added_via not null default 'manual',
  added_at          timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index inventory_items_restaurant_id_idx on public.inventory_items (restaurant_id);
create index inventory_items_wine_id_idx       on public.inventory_items (wine_id);
create index inventory_items_scan_id_idx       on public.inventory_items (invoice_scan_id);

create trigger inventory_items_set_updated_at
  before update on public.inventory_items
  for each row execute function public.set_updated_at();

alter table public.inventory_items enable row level security;

create policy "members can read their inventory"
  on public.inventory_items for select to authenticated
  using (public.is_member(restaurant_id));

create policy "members can insert inventory"
  on public.inventory_items for insert to authenticated
  with check (public.is_member(restaurant_id));

create policy "members can update their inventory"
  on public.inventory_items for update to authenticated
  using (public.is_member(restaurant_id))
  with check (public.is_member(restaurant_id));

create policy "members can delete their inventory"
  on public.inventory_items for delete to authenticated
  using (public.is_member(restaurant_id));

-------------------------------------------------------------------------------
-- wine_lists — saved lists with publishing
-------------------------------------------------------------------------------
create table public.wine_lists (
  id                uuid        primary key default gen_random_uuid(),
  restaurant_id     uuid        not null references public.restaurants(id) on delete cascade,
  name              text        not null,
  template          text        not null default 'classic',
  slug              text,
  is_published      boolean     not null default false,
  last_published_at timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create unique index wine_lists_slug_idx
  on public.wine_lists (slug) where slug is not null;
create index wine_lists_restaurant_id_idx
  on public.wine_lists (restaurant_id);

create trigger wine_lists_set_updated_at
  before update on public.wine_lists
  for each row execute function public.set_updated_at();

alter table public.wine_lists enable row level security;

create policy "members can read their wine lists"
  on public.wine_lists for select to authenticated
  using (public.is_member(restaurant_id));

create policy "published wine lists are public"
  on public.wine_lists for select to anon
  using (is_published = true);

create policy "members can insert wine lists"
  on public.wine_lists for insert to authenticated
  with check (public.is_member(restaurant_id));

create policy "members can update their wine lists"
  on public.wine_lists for update to authenticated
  using (public.is_member(restaurant_id))
  with check (public.is_member(restaurant_id));

create policy "members can delete their wine lists"
  on public.wine_lists for delete to authenticated
  using (public.is_member(restaurant_id));

-------------------------------------------------------------------------------
-- wine_list_sections — ordered sections within a list
-------------------------------------------------------------------------------
create table public.wine_list_sections (
  id            uuid        primary key default gen_random_uuid(),
  wine_list_id  uuid        not null references public.wine_lists(id) on delete cascade,
  name          text        not null,
  position      int         not null default 0,
  created_at    timestamptz not null default now()
);

create index wine_list_sections_list_id_idx
  on public.wine_list_sections (wine_list_id);

alter table public.wine_list_sections enable row level security;

create policy "members can read their sections"
  on public.wine_list_sections for select to authenticated
  using (exists (
    select 1 from public.wine_lists wl
    where wl.id = wine_list_id and public.is_member(wl.restaurant_id)
  ));

create policy "published list sections are public"
  on public.wine_list_sections for select to anon
  using (exists (
    select 1 from public.wine_lists wl
    where wl.id = wine_list_id and wl.is_published = true
  ));

create policy "members can insert sections"
  on public.wine_list_sections for insert to authenticated
  with check (exists (
    select 1 from public.wine_lists wl
    where wl.id = wine_list_id and public.is_member(wl.restaurant_id)
  ));

create policy "members can update their sections"
  on public.wine_list_sections for update to authenticated
  using (exists (
    select 1 from public.wine_lists wl
    where wl.id = wine_list_id and public.is_member(wl.restaurant_id)
  ));

create policy "members can delete their sections"
  on public.wine_list_sections for delete to authenticated
  using (exists (
    select 1 from public.wine_lists wl
    where wl.id = wine_list_id and public.is_member(wl.restaurant_id)
  ));

-------------------------------------------------------------------------------
-- wine_list_items — wines placed in sections with pricing
-------------------------------------------------------------------------------
create table public.wine_list_items (
  id            uuid          primary key default gen_random_uuid(),
  section_id    uuid          not null references public.wine_list_sections(id) on delete cascade,
  wine_id       uuid          not null references public.wines(id) on delete restrict,
  position      int           not null default 0,
  glass_price   numeric(10,2),
  bottle_price  numeric(10,2),
  tasting_note  text,
  is_available  boolean       not null default true,
  created_at    timestamptz   not null default now(),
  updated_at    timestamptz   not null default now()
);

create index wine_list_items_section_id_idx
  on public.wine_list_items (section_id);
create index wine_list_items_position_idx
  on public.wine_list_items (section_id, position);

create trigger wine_list_items_set_updated_at
  before update on public.wine_list_items
  for each row execute function public.set_updated_at();

alter table public.wine_list_items enable row level security;

create policy "members can read their list items"
  on public.wine_list_items for select to authenticated
  using (exists (
    select 1 from public.wine_list_sections s
    join public.wine_lists wl on wl.id = s.wine_list_id
    where s.id = section_id and public.is_member(wl.restaurant_id)
  ));

create policy "published list items are public"
  on public.wine_list_items for select to anon
  using (exists (
    select 1 from public.wine_list_sections s
    join public.wine_lists wl on wl.id = s.wine_list_id
    where s.id = section_id and wl.is_published = true
  ));

create policy "members can insert list items"
  on public.wine_list_items for insert to authenticated
  with check (exists (
    select 1 from public.wine_list_sections s
    join public.wine_lists wl on wl.id = s.wine_list_id
    where s.id = section_id and public.is_member(wl.restaurant_id)
  ));

create policy "members can update their list items"
  on public.wine_list_items for update to authenticated
  using (exists (
    select 1 from public.wine_list_sections s
    join public.wine_lists wl on wl.id = s.wine_list_id
    where s.id = section_id and public.is_member(wl.restaurant_id)
  ));

create policy "members can delete their list items"
  on public.wine_list_items for delete to authenticated
  using (exists (
    select 1 from public.wine_list_sections s
    join public.wine_lists wl on wl.id = s.wine_list_id
    where s.id = section_id and public.is_member(wl.restaurant_id)
  ));

-------------------------------------------------------------------------------
-- find_or_create_wine — upsert with dedup
-------------------------------------------------------------------------------
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
  -- Try to find existing wine
  select id into wine_id
  from public.wines
  where restaurant_id = p_restaurant_id
    and lower(producer) = lower(p_producer)
    and lower(name)     = lower(p_name)
    and coalesce(vintage, 0) = coalesce(p_vintage, 0)
    and size_ml = p_size_ml
  limit 1;

  if wine_id is not null then
    -- Fill in missing fields if we have better data now
    update public.wines
    set varietal = coalesce(wines.varietal, p_varietal),
        region   = coalesce(wines.region, p_region),
        country  = coalesce(wines.country, p_country)
    where id = wine_id
      and (wines.varietal is null or wines.region is null or wines.country is null);
    return wine_id;
  end if;

  -- Insert new wine
  insert into public.wines (restaurant_id, name, producer, vintage, varietal, region, country, size_ml)
  values (p_restaurant_id, p_name, p_producer, p_vintage, p_varietal, p_region, p_country, p_size_ml)
  on conflict (restaurant_id, lower(producer), lower(name), coalesce(vintage, 0), size_ml)
  do update set
    varietal = coalesce(excluded.varietal, wines.varietal),
    region   = coalesce(excluded.region, wines.region),
    country  = coalesce(excluded.country, wines.country)
  returning id into wine_id;

  return wine_id;
end;
$$;

revoke all on function public.find_or_create_wine(uuid, text, text, int, text, text, text, int) from public;
grant execute on function public.find_or_create_wine(uuid, text, text, int, text, text, text, int) to authenticated;

-------------------------------------------------------------------------------
-- generate_slug — human-readable slug for wine lists
-------------------------------------------------------------------------------
create or replace function public.generate_slug(input text)
returns text
language plpgsql
as $$
declare
  base_slug text;
  suffix text;
begin
  -- Lowercase, replace non-alphanumeric with hyphens, collapse multiples, trim
  base_slug := regexp_replace(lower(trim(input)), '[^a-z0-9]+', '-', 'g');
  base_slug := regexp_replace(base_slug, '^-+|-+$', '', 'g');
  base_slug := left(base_slug, 40);

  -- 3-char random suffix
  suffix := substring(md5(random()::text) from 1 for 3);

  return base_slug || '-' || suffix;
end;
$$;

-------------------------------------------------------------------------------
-- Storage bucket for invoice images
-- (Run this via Supabase Dashboard or SQL editor — storage schema operations)
-------------------------------------------------------------------------------
-- insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
-- values (
--   'invoice-images',
--   'invoice-images',
--   false,
--   20971520,  -- 20 MB
--   array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']
-- );

-- === 0003_wine_intelligence.sql ===
-- 0003_wine_intelligence.sql
-- Add drink window and serving temperature columns to wines table.
-- Create lwin_catalog reference table for wine data enrichment.

-------------------------------------------------------------------------------
-- wines — add intelligence columns
-------------------------------------------------------------------------------
alter table public.wines
  add column drink_window_start int,
  add column drink_window_end   int,
  add column serving_temp_min   int,
  add column serving_temp_max   int,
  add column serving_temp_label text;

-------------------------------------------------------------------------------
-- lwin_catalog — Liv-ex LWIN reference data for matching and enrichment
-------------------------------------------------------------------------------
create extension if not exists pg_trgm;

create table public.lwin_catalog (
  lwin_id       text        primary key,
  display_name  text        not null,
  producer      text,
  varietal      text,
  region        text,
  country       text,
  colour        text,
  type          text
);

create index lwin_catalog_producer_trgm_idx
  on public.lwin_catalog using gin (producer gin_trgm_ops);

create index lwin_catalog_display_name_trgm_idx
  on public.lwin_catalog using gin (display_name gin_trgm_ops);

create index lwin_catalog_varietal_idx
  on public.lwin_catalog (varietal);

-- lwin_catalog is a global reference table — read-only for all authenticated users
alter table public.lwin_catalog enable row level security;

create policy "anyone can read lwin_catalog"
  on public.lwin_catalog for select to authenticated
  using (true);

-- === 0004_team_invitations.sql ===
-- 0004_team_invitations.sql
-- Invitations table for team member invites via shareable links.

create table public.invitations (
  id             uuid        primary key default gen_random_uuid(),
  restaurant_id  uuid        not null references public.restaurants(id) on delete cascade,
  email          text,
  role           public.membership_role not null default 'staff',
  invited_by     uuid        not null references auth.users(id),
  token          text        not null unique default encode(gen_random_bytes(24), 'hex'),
  expires_at     timestamptz not null default (now() + interval '7 days'),
  accepted_at    timestamptz,
  created_at     timestamptz not null default now()
);

create index invitations_token_idx on public.invitations (token);
create index invitations_restaurant_id_idx on public.invitations (restaurant_id);

alter table public.invitations enable row level security;

create policy "owners can manage invitations"
  on public.invitations for all to authenticated
  using (public.is_member_with_role(restaurant_id, 'owner'))
  with check (public.is_member_with_role(restaurant_id, 'owner'));

create policy "managers can read invitations"
  on public.invitations for select to authenticated
  using (public.is_member_with_role(restaurant_id, 'manager'));

-- === 0005_cellar_config.sql ===
-- 0005_cellar_config.sql
-- Cellar configuration for SVG grid visualization.

create table public.cellar_config (
  id             uuid        primary key default gen_random_uuid(),
  restaurant_id  uuid        not null references public.restaurants(id) on delete cascade,
  name           text        not null default 'Main Cellar',
  rows           int         not null default 10,
  columns        int         not null default 10,
  labels         jsonb       not null default '{}',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (restaurant_id, name)
);

create trigger cellar_config_set_updated_at
  before update on public.cellar_config
  for each row execute function public.set_updated_at();

alter table public.cellar_config enable row level security;

create policy "members can read cellar config"
  on public.cellar_config for select to authenticated
  using (public.is_member(restaurant_id));

create policy "managers can manage cellar config"
  on public.cellar_config for all to authenticated
  using (public.is_member_with_role(restaurant_id, 'manager'))
  with check (public.is_member_with_role(restaurant_id, 'manager'));

-- === 0006_batch_find_or_create_wines.sql ===
-- 0006_batch_find_or_create_wines.sql
-- Batch version of find_or_create_wine to avoid N sequential RPC calls.
-- Accepts a JSONB array, returns wine UUIDs in input order.

create or replace function public.find_or_create_wines_batch(
  p_restaurant_id uuid,
  p_wines         jsonb
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

    -- Try to find existing wine
    select w.id into wine_id
    from public.wines w
    where w.restaurant_id = p_restaurant_id
      and lower(w.producer) = lower(wine_record ->> 'producer')
      and lower(w.name)     = lower(wine_record ->> 'name')
      and coalesce(w.vintage, 0) = coalesce((wine_record ->> 'vintage')::int, 0)
      and w.size_ml = coalesce((wine_record ->> 'size_ml')::int, 750)
    limit 1;

    if wine_id is not null then
      -- Fill in missing fields
      update public.wines
      set varietal = coalesce(wines.varietal, wine_record ->> 'varietal'),
          region   = coalesce(wines.region, wine_record ->> 'region'),
          country  = coalesce(wines.country, wine_record ->> 'country')
      where id = wine_id
        and (wines.varietal is null or wines.region is null or wines.country is null);
    else
      -- Insert new wine
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
        region   = coalesce(excluded.region, wines.region),
        country  = coalesce(excluded.country, wines.country)
      returning id into wine_id;
    end if;

    wine_ids := wine_ids || wine_id;
  end loop;

  return wine_ids;
end;
$$;

revoke all on function public.find_or_create_wines_batch(uuid, jsonb) from public;
grant execute on function public.find_or_create_wines_batch(uuid, jsonb) to authenticated;

-- === 0007_lwin_matching.sql ===
-- 0007_lwin_matching.sql
-- LWIN fuzzy matching functions using pg_trgm trigram indexes
-- already on lwin_catalog (producer, display_name).

-- Single-wine match: returns best LWIN match above threshold
create or replace function public.match_lwin(
  p_producer  text,
  p_name      text,
  p_threshold float default 0.3
)
returns table (
  lwin_id      text,
  display_name text,
  producer     text,
  varietal     text,
  region       text,
  country      text,
  colour       text,
  score        float
)
language sql stable security definer set search_path = public
as $$
  select lc.lwin_id, lc.display_name, lc.producer, lc.varietal,
         lc.region, lc.country, lc.colour,
         (similarity(lower(p_producer), lower(lc.producer)) * 0.6 +
          similarity(lower(p_name), lower(lc.display_name)) * 0.4) as score
  from public.lwin_catalog lc
  where similarity(lower(p_producer), lower(lc.producer)) >= p_threshold
    and similarity(lower(p_name), lower(lc.display_name)) >= p_threshold * 0.7
  order by score desc
  limit 1;
$$;

revoke all on function public.match_lwin(text, text, float) from public;
grant execute on function public.match_lwin(text, text, float) to authenticated;

-- Batch match: loops through wine IDs, matches each against lwin_catalog,
-- updates wine with lwin_id + fills null country/region/varietal.
create or replace function public.match_lwin_batch(p_wine_ids uuid[])
returns table (wine_id uuid, lwin_id text, score float)
language plpgsql security definer set search_path = public
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

revoke all on function public.match_lwin_batch(uuid[]) from public;
grant execute on function public.match_lwin_batch(uuid[]) to authenticated;

-- Catalog search: fast trigram search for the add-wine modal autocomplete.
create or replace function public.lwin_search(p_query text, p_limit int default 20)
returns setof public.lwin_catalog
language sql stable security definer set search_path = public
as $$
  select *
  from public.lwin_catalog
  where producer % p_query or display_name % p_query
  order by greatest(
    similarity(lower(producer), lower(p_query)),
    similarity(lower(display_name), lower(p_query))
  ) desc
  limit p_limit;
$$;

revoke all on function public.lwin_search(text, int) from public;
grant execute on function public.lwin_search(text, int) to authenticated;

-- === 0008_public_wine_read.sql ===
-- Allow anonymous (public) users to read wines that appear in published wine lists.
-- This enables the /list/[slug] SSR page to join wines via the anon key instead
-- of the service role key, keeping RLS as a safety net.

create policy "public can read wines in published lists"
  on public.wines for select to anon
  using (
    exists (
      select 1
      from public.wine_list_items wli
      join public.wine_list_sections wls on wls.id = wli.section_id
      join public.wine_lists wl on wl.id = wls.wine_list_id
      where wli.wine_id = wines.id
        and wl.is_published = true
    )
  );

-- === 0009_invoice_image_storage.sql ===
-- 0009_invoice_image_storage.sql
-- Create storage bucket for invoice images and set up RLS policies.

-- Create the bucket (private, 20 MB limit)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'invoice-images',
  'invoice-images',
  false,
  20971520,
  array['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'application/pdf']
);

-- RLS: members can upload images scoped to their restaurant
create policy "members can upload invoice images"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'invoice-images'
    and public.is_member((storage.foldername(name))[1]::uuid)
  );

-- RLS: members can read images scoped to their restaurant
create policy "members can read invoice images"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'invoice-images'
    and public.is_member((storage.foldername(name))[1]::uuid)
  );

-- === 0010_bottle_scan_enum.sql ===
-- 0010_bottle_scan_enum.sql
-- Add 'bottle_scan' to the added_via enum for inventory items added by scanning a bottle label.

alter type public.added_via add value if not exists 'bottle_scan';

-- === 0011_scan_idempotency.sql ===
-- BND-006 / INT-005
--
-- Idempotency cache for the two inventory-save endpoints
-- (/api/inventory/save-scan and /api/inventory/save-bottle-scan). The
-- client sends an `Idempotency-Key` header (UUIDv4 generated when the
-- save is first attempted) and reuses the same key on retry. This table
-- stores the cached response keyed by (key, restaurant_id) so that:
--
--   - a successful save followed by a retry returns the original
--     response body without re-inserting inventory rows, and
--   - a true failure (server exception) deletes the row so the user can
--     retry without being stuck on a stale cached error.
--
-- TTL is 24 hours, enforced lazily by the cleanup_scan_idempotency()
-- function (callable from supabase scheduled-jobs / pg_cron). The (key,
-- restaurant_id) primary key + the composite key restaurant_id scope
-- means stolen UUIDs from another tenant can't replay responses across
-- the boundary.
--
-- DOWN:
--   drop function if exists public.cleanup_scan_idempotency();
--   drop table if exists public.scan_idempotency;

create table public.scan_idempotency (
  key              uuid not null,
  restaurant_id    uuid not null references public.restaurants(id) on delete cascade,
  response_status  integer,
  response_body    jsonb,
  created_at       timestamptz not null default now(),
  primary key (key, restaurant_id)
);

create index idx_scan_idempotency_created_at
  on public.scan_idempotency (created_at);

alter table public.scan_idempotency enable row level security;

-- Members of the restaurant can read/write only their own keys. RLS uses
-- the existing is_member() SECURITY DEFINER helper so the policy doesn't
-- recurse through memberships' own RLS.
create policy "members manage own idempotency keys"
  on public.scan_idempotency
  for all
  to authenticated
  using (public.is_member(restaurant_id))
  with check (public.is_member(restaurant_id));

-- TTL cleanup. Call from pg_cron / supabase scheduled-jobs nightly:
--   select public.cleanup_scan_idempotency();
create or replace function public.cleanup_scan_idempotency()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.scan_idempotency
  where created_at < now() - interval '24 hours';
$$;

revoke all on function public.cleanup_scan_idempotency() from public;
grant execute on function public.cleanup_scan_idempotency() to service_role;

-- === 0012_wine_list_items_wine_id_idx.sql ===
-- BND-009 / INT-008
--
-- The "public can read wines in published lists" RLS policy correlates
-- every wines row against wine_list_items.wine_id (see migration
-- 0008_public_wine_read.sql). With no index on that FK column, every
-- public-list render produces a sequential scan of wine_list_items per
-- wine row. As wine_list_items grows past a few thousand rows the
-- public /list/[slug] page becomes O(n²).
--
-- A plain btree on wine_list_items.wine_id is the right fix — the column
-- is high-cardinality (one row per (section, wine) pair) and the policy's
-- existence-check is an equality predicate. Created CONCURRENTLY would be
-- safer in production, but supabase migrations run inside a transaction
-- so we use the regular form. The table is small enough today that the
-- AccessExclusiveLock window is sub-second.
--
-- DOWN:
--   DROP INDEX IF EXISTS public.idx_wine_list_items_wine_id;

create index if not exists idx_wine_list_items_wine_id
  on public.wine_list_items (wine_id);

-- === 0013_reorder_wine_list_items_rpc.sql ===
-- BND-026 / ARCH-007
--
-- Atomic reorder for wine_list_items within a single section.
--
-- The previous /api/wine-list-items/reorder route issued N individual UPDATE
-- statements via Promise.all. A mid-batch failure (RLS violation, transient
-- network, etc.) left the list with mixed old + new positions — the user's
-- drag-drop appeared partially-committed and there was no rollback path.
--
-- This function consolidates the N updates into a single statement executed
-- inside plpgsql's implicit transaction. Either every position lands or none.
-- Runs as SECURITY INVOKER so existing RLS on wine_list_items still applies;
-- the explicit section-membership assertion below is defense-in-depth.
--
-- DOWN (manual, not a migration file — migrations are forward-only per INT-006):
--   DROP FUNCTION IF EXISTS public.reorder_wine_list_items(uuid[]);

create or replace function public.reorder_wine_list_items(
  p_ordered_ids uuid[]
) returns void
language plpgsql
security invoker
as $$
declare
  v_section_id uuid;
  v_input_len int;
  v_match_count int;
begin
  v_input_len := coalesce(array_length(p_ordered_ids, 1), 0);

  -- Empty input is a no-op — behave identically to the old route's
  -- 400 early-exit for empty orderedIds (the route still 400s; this is belt-and-braces).
  if v_input_len = 0 then
    return;
  end if;

  -- Infer section from the first id. RLS on wine_list_items means a user
  -- without membership will see NULL here and we'll fail the assert below.
  select section_id into v_section_id
  from public.wine_list_items
  where id = p_ordered_ids[1];

  if v_section_id is null then
    raise exception 'reorder_wine_list_items: item % not found or inaccessible', p_ordered_ids[1];
  end if;

  -- Assert every id belongs to the same section the caller can see.
  -- This catches: (a) stale client sending ids from a deleted item,
  -- (b) ids from a different section (accidental mixed-section drag),
  -- (c) cross-tenant ids (RLS would filter them so v_match_count is short).
  select count(*) into v_match_count
  from public.wine_list_items
  where id = any(p_ordered_ids)
    and section_id = v_section_id;

  if v_match_count <> v_input_len then
    raise exception 'reorder_wine_list_items: % ids submitted, % accessible in section %',
      v_input_len, v_match_count, v_section_id;
  end if;

  -- Single atomic UPDATE using unnest WITH ORDINALITY. Positions are
  -- 0-indexed to match the previous route's `idx` from Array.map.
  update public.wine_list_items
  set position = arr.idx - 1
  from unnest(p_ordered_ids) with ordinality as arr(id, idx)
  where public.wine_list_items.id = arr.id
    and public.wine_list_items.section_id = v_section_id;
end;
$$;

comment on function public.reorder_wine_list_items(uuid[]) is
  'BND-026: atomic reorder for wine_list_items within a section. All positions land or none do.';

-- === 0014_enrich_wines_batch.sql ===
-- BND-031 / DEBT-008
--
-- Atomic batch enrichment for wines. The previous /api/wines/enrich route
-- fired one UPDATE per wine via Promise.all — 500 wines = 500 concurrent
-- Supabase round-trips, connection-pool pressure, and no atomicity. The
-- enrichment values come from a deterministic rule engine (no external API),
-- so we can compute them in Node and ship the entire batch to the DB in a
-- single jsonb payload.
--
-- The function does one UPDATE with a join to jsonb_array_elements, scoped
-- to p_restaurant_id as defense-in-depth (even if a caller smuggled in ids
-- from another tenant, the restaurant filter would no-op them).
--
-- DOWN (manual, not a migration file):
--   DROP FUNCTION IF EXISTS public.enrich_wines_batch(uuid, jsonb);

create or replace function public.enrich_wines_batch(
  p_restaurant_id uuid,
  p_enrichments   jsonb
) returns int
language plpgsql
security invoker
as $$
declare
  v_count int;
begin
  if p_enrichments is null or jsonb_typeof(p_enrichments) <> 'array' or jsonb_array_length(p_enrichments) = 0 then
    return 0;
  end if;

  with u as (
    select
      (e->>'id')::uuid                  as id,
      (e->>'drink_window_start')::int    as drink_window_start,
      (e->>'drink_window_end')::int      as drink_window_end,
      (e->>'serving_temp_min')::int      as serving_temp_min,
      (e->>'serving_temp_max')::int      as serving_temp_max,
      (e->>'serving_temp_label')         as serving_temp_label
    from jsonb_array_elements(p_enrichments) as e
  )
  update public.wines w
  set
    drink_window_start = u.drink_window_start,
    drink_window_end   = u.drink_window_end,
    serving_temp_min   = u.serving_temp_min,
    serving_temp_max   = u.serving_temp_max,
    serving_temp_label = u.serving_temp_label
  from u
  where w.id = u.id
    and w.restaurant_id = p_restaurant_id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.enrich_wines_batch(uuid, jsonb) is
  'BND-031: atomic batch enrichment of wines. Returns the number of rows updated.';

-- === 0015_wine_availability.sql ===
-- BND-037: wine-scoped 86'd flag + full audit log.
-- Flag lives on wines (direct columns — reads are frequent, co-located with
-- the row we're already selecting). Events go into a separate table for
-- unbounded history. Atomic writes go through the set_wine_availability
-- RPC to guarantee wines + events row land in one transaction.
--
-- DOWN (manual, not a migration file — migrations are forward-only):
--   DROP FUNCTION IF EXISTS public.set_wine_availability(uuid, text, text);
--   DROP TABLE IF EXISTS public.availability_events;
--   DROP INDEX IF EXISTS public.wines_eightysixed_idx;
--   GRANT UPDATE (is_eightysixed, eightysixed_at, eightysixed_by)
--     ON public.wines TO authenticated;
--   ALTER TABLE public.wines
--     DROP COLUMN IF EXISTS eightysixed_by,
--     DROP COLUMN IF EXISTS eightysixed_at,
--     DROP COLUMN IF EXISTS is_eightysixed;

-- ── 1. Columns on wines ────────────────────────────────────────────
alter table public.wines
  add column is_eightysixed boolean not null default false,
  add column eightysixed_at timestamptz,
  add column eightysixed_by uuid references auth.users(id);

create index wines_eightysixed_idx
  on public.wines (restaurant_id, is_eightysixed);

-- Integrity guard: revoke column-level UPDATE on the three availability
-- columns from `authenticated`. Migration 0002 grants a permissive
-- "members can update their wines" RLS policy which would otherwise
-- let staff write these columns directly, bypassing the audit-logging
-- RPC. Column-level REVOKE tightens this WITHOUT changing other wines
-- UPDATE flows (name, producer, etc.) that staff may legitimately need.
revoke update (is_eightysixed, eightysixed_at, eightysixed_by)
  on public.wines from authenticated;

-- ── 2. availability_events table ───────────────────────────────────
create table public.availability_events (
  id              uuid primary key default gen_random_uuid(),
  wine_id         uuid not null references public.wines(id) on delete cascade,
  restaurant_id   uuid not null references public.restaurants(id) on delete cascade,
  direction       text not null check (direction in ('eightysixed', 'restored')),
  user_id         uuid references auth.users(id),
  note            text,
  created_at      timestamptz not null default now()
);

create index availability_events_wine_idx
  on public.availability_events (restaurant_id, wine_id, created_at desc);

create index availability_events_restaurant_idx
  on public.availability_events (restaurant_id, created_at desc);

alter table public.availability_events enable row level security;

create policy "members can read availability events"
  on public.availability_events for select to authenticated
  using (public.is_member(restaurant_id));

-- Inserts happen ONLY via the set_wine_availability RPC (security invoker).
-- No direct-insert policy needed.

-- ── 3. set_wine_availability RPC ───────────────────────────────────
-- SECURITY DEFINER so it can bypass the REVOKE above and write the
-- three protected columns. Internal role check (owner/manager only)
-- is the real gate. RETURNS SETOF so the idempotent no-op returns
-- zero rows and the state-change case returns exactly one row —
-- unambiguous contract over PostgREST.

create or replace function public.set_wine_availability(
  p_wine_id   uuid,
  p_direction text,
  p_note      text
) returns setof public.availability_events
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id       uuid := auth.uid();
  v_current       boolean;
  v_restaurant_id uuid;
  v_event         public.availability_events%rowtype;
  v_target        boolean := case p_direction
                               when 'eightysixed' then true
                               when 'restored'    then false
                               else null
                             end;
begin
  if v_target is null then
    raise exception 'invalid direction: %', p_direction;
  end if;

  if v_user_id is null then
    raise exception 'authentication required';
  end if;

  select w.is_eightysixed, w.restaurant_id
    into v_current, v_restaurant_id
  from public.wines w
  where w.id = p_wine_id;

  if not found then
    raise exception 'wine not found: %', p_wine_id;
  end if;

  -- DEFINER bypasses RLS on writes, so we must verify the caller's
  -- membership + role explicitly against the wine's restaurant.
  if not (public.is_member_with_role(v_restaurant_id, 'owner')
          or public.is_member_with_role(v_restaurant_id, 'manager')) then
    raise exception 'owner or manager role required to set availability';
  end if;

  if v_current = v_target then
    -- Idempotent no-op: return zero rows, nothing to log.
    return;
  end if;

  update public.wines
     set is_eightysixed = v_target,
         eightysixed_at = case when v_target then now() else null end,
         eightysixed_by = case when v_target then v_user_id else null end
   where id = p_wine_id;

  insert into public.availability_events
    (wine_id, restaurant_id, direction, user_id, note)
  values
    (p_wine_id, v_restaurant_id, p_direction, v_user_id, nullif(trim(p_note), ''))
  returning * into v_event;

  return next v_event;
  return;
end;
$$;

revoke execute on function public.set_wine_availability(uuid, text, text) from public;
grant  execute on function public.set_wine_availability(uuid, text, text) to authenticated;

comment on function public.set_wine_availability(uuid, text, text) is
  'BND-037: atomic toggle of wines.is_eightysixed + availability_events insert. SECURITY DEFINER with internal owner/manager check. Returns SETOF — empty set when already in target state (idempotent), one row when a change occurred.';

-- ── 4. Deprecate legacy wine_list_items.is_available ───────────────
comment on column public.wine_list_items.is_available is
  'DEPRECATED in BND-037. Availability is now wine-scoped at wines.is_eightysixed. This column is unused; leave in place to avoid a touchy migration during feature launch. Safe to drop in a future cleanup once we confirm no external consumers.';

-- === 0016_pour_tracking.sql ===
-- 0016_pour_tracking.sql — BND-038
-- Oz-native inventory: partial-bottle tracking for by-the-glass wines.
-- Design: docs/plans/2026-04-22-oz-native-inventory-design.md
-- Plan:   docs/plans/2026-04-22-oz-native-inventory-plan.md
--
-- Adds:
--   - wine_list_items.glass_pour_ml + wine_list_items.pour_size_mode
--   - open_bottles (materialized current-state table, unique per wine+restaurant)
--   - pour_events (append-only ledger; trigger-driven state maintenance)
--   - record_pour RPC (atomic tap flow: open/pour/overage/oos)
--   - reconcile_open_bottle RPC (manager-only end-of-shift correction)

-- 1. Extend wine_list_items -----------------------------------------------

alter table public.wine_list_items
  add column glass_pour_ml  int check (glass_pour_ml is null or glass_pour_ml > 0),
  add column pour_size_mode text not null default 'fixed'
    check (pour_size_mode in ('fixed','picker'));

comment on column public.wine_list_items.glass_pour_ml is
  'Default ml subtracted per pour tap. NULL = wine is not pour-tracked (bottle-only).';
comment on column public.wine_list_items.pour_size_mode is
  'fixed = tap subtracts glass_pour_ml; picker = tap opens picker modal.';

-- 2. open_bottles — materialized current partial-bottle state -------------

create table public.open_bottles (
  id                        uuid primary key default gen_random_uuid(),
  wine_id                   uuid not null references public.wines(id) on delete cascade,
  restaurant_id             uuid not null references public.restaurants(id) on delete cascade,
  remaining_ml              int  not null check (remaining_ml >= 0),
  opened_at                 timestamptz not null default now(),
  opened_by                 uuid references auth.users(id),
  source_inventory_item_id  uuid references public.inventory_items(id) on delete set null,
  unique (wine_id, restaurant_id)
);

create index open_bottles_restaurant_idx on public.open_bottles (restaurant_id);

alter table public.open_bottles enable row level security;

create policy "members can read open_bottles"
  on public.open_bottles for select to authenticated
  using (public.is_member(restaurant_id));

-- Writes happen only through SECURITY DEFINER RPCs.
revoke insert, update, delete on public.open_bottles from authenticated;

-- 3. pour_events — append-only ledger -------------------------------------

create table public.pour_events (
  id             uuid primary key default gen_random_uuid(),
  wine_id        uuid not null references public.wines(id) on delete restrict,
  restaurant_id  uuid not null references public.restaurants(id) on delete cascade,
  ml_delta       int  not null,
  kind           text not null check (kind in ('pour','spill','reconcile','new_bottle','finish_bottle')),
  actor_user_id  uuid references auth.users(id),
  occurred_at    timestamptz not null default now(),
  note           text
);

create index pour_events_wine_occurred_idx
  on public.pour_events (wine_id, occurred_at desc);
create index pour_events_restaurant_occurred_idx
  on public.pour_events (restaurant_id, occurred_at desc);

alter table public.pour_events enable row level security;

create policy "members can read pour_events"
  on public.pour_events for select to authenticated
  using (public.is_member(restaurant_id));

revoke insert, update, delete on public.pour_events from authenticated;

-- 4. Trigger: maintain open_bottles.remaining_ml from the ledger ----------

create or replace function public.pour_events_maintain_open_bottle()
returns trigger
language plpgsql
as $$
begin
  if NEW.kind = 'new_bottle' then
    -- ml_delta for new_bottle is negative = -size_ml; insert/replace open_bottles.
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
    -- Positive ml_delta: subtract from remaining.
    update public.open_bottles
      set remaining_ml = greatest(0, remaining_ml - NEW.ml_delta)
      where wine_id = NEW.wine_id and restaurant_id = NEW.restaurant_id;
    -- If we drained it, remove the row.
    delete from public.open_bottles
      where wine_id = NEW.wine_id and restaurant_id = NEW.restaurant_id
        and remaining_ml = 0;

  elsif NEW.kind = 'reconcile' then
    -- Signed ml_delta: positive reduces, negative increases.
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

create trigger pour_events_trigger
  after insert on public.pour_events
  for each row execute function public.pour_events_maintain_open_bottle();

-- 5. RPC: record_pour -----------------------------------------------------

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

    -- Decrement sealed inventory, then record new_bottle event
    -- (trigger creates the open_bottles row with remaining_ml = size_ml).
    update public.inventory_items
      set quantity = quantity - 1
      where id = v_sealed_item.id;

    insert into public.pour_events
      (wine_id, restaurant_id, ml_delta, kind, actor_user_id, note)
    values
      (p_wine_id, v_restaurant_id, -v_size_ml, 'new_bottle', v_user, p_note);

    -- Read the freshly-inserted open_bottles row for the next comparison.
    select * into v_current
      from public.open_bottles
      where wine_id = p_wine_id and restaurant_id = v_restaurant_id;
  end if;

  if v_current.remaining_ml >= p_ml then
    -- Simple pour / spill.
    insert into public.pour_events
      (wine_id, restaurant_id, ml_delta, kind, actor_user_id, note)
    values
      (p_wine_id, v_restaurant_id, p_ml, p_kind, v_user, p_note);
  else
    -- Overage: finish current, open next, pour the full amount.
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

    insert into public.pour_events
      (wine_id, restaurant_id, ml_delta, kind, actor_user_id, note)
    values
      (p_wine_id, v_restaurant_id, p_ml, p_kind, v_user, p_note);
  end if;

  -- Return the (possibly new) open_bottles row.
  select * into v_current
    from public.open_bottles
    where wine_id = p_wine_id and restaurant_id = v_restaurant_id;
  return v_current;
end;
$$;

grant execute on function public.record_pour(uuid, int, text, text) to authenticated;

-- 6. RPC: reconcile_open_bottle -------------------------------------------

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
  v_current       public.open_bottles%rowtype;
  v_delta         int;
  v_user          uuid := auth.uid();
begin
  if p_new_remaining_ml < 0 then
    raise exception 'p_new_remaining_ml must be >= 0';
  end if;

  select restaurant_id into v_restaurant_id
    from public.wines where id = p_wine_id;
  if v_restaurant_id is null then
    raise exception 'wine not found';
  end if;

  if not public.is_member_with_role(v_restaurant_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_current
    from public.open_bottles
    where wine_id = p_wine_id and restaurant_id = v_restaurant_id
    for update;

  if not found then
    raise exception 'no open bottle for this wine';
  end if;

  v_delta := v_current.remaining_ml - p_new_remaining_ml;

  if v_delta = 0 then
    return v_current;  -- no-op
  end if;

  insert into public.pour_events
    (wine_id, restaurant_id, ml_delta, kind, actor_user_id, note)
  values
    (p_wine_id, v_restaurant_id, v_delta, 'reconcile', v_user, p_note);

  select * into v_current
    from public.open_bottles
    where wine_id = p_wine_id and restaurant_id = v_restaurant_id;
  return v_current;
end;
$$;

grant execute on function public.reconcile_open_bottle(uuid, int, text) to authenticated;

-- === 0017_list_open_bottle_items.sql ===
-- 0017_list_open_bottle_items.sql — BND-038
-- Read helper for GET /api/open-bottles and the /pour + /reconcile server
-- components. Aggregates by-the-glass wine_list_items with their current
-- open_bottles state + sealed inventory count.

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

-- === 0018_reconcile_hardening.sql ===
-- 0018_reconcile_hardening.sql — BND-038 (code-review fixes)
--
-- Two changes in response to the code review of commits 021c2c3..4bb433f:
--
-- 1. reconcile_open_bottle now rejects p_new_remaining_ml > size_ml
--    with errcode 'P0002'. Prevents a manager's typo (e.g., "7500"
--    instead of "750") from inflating remaining_ml above the physical
--    bottle capacity.
--
-- 2. New batch RPC reconcile_open_bottles_batch iterates inside a
--    single transaction. The Node route now calls this instead of
--    looping — a mid-batch failure rolls back the whole set, so the
--    API is truly atomic and retry-idempotent (prior implementation
--    had partial-apply behavior flagged in the review).

-- 1. Replace reconcile_open_bottle with the size-capped version. ---------

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

  -- Cap: physical bottles can't hold more than size_ml. Raising with
  -- a named errcode so the HTTP route can map this to 400.
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
    for update;

  if not found then
    raise exception 'no open bottle for this wine';
  end if;

  v_delta := v_current.remaining_ml - p_new_remaining_ml;

  if v_delta = 0 then
    return v_current;
  end if;

  insert into public.pour_events
    (wine_id, restaurant_id, ml_delta, kind, actor_user_id, note)
  values
    (p_wine_id, v_restaurant_id, v_delta, 'reconcile', v_user, p_note);

  select * into v_current
    from public.open_bottles
    where wine_id = p_wine_id and restaurant_id = v_restaurant_id;
  return v_current;
end;
$$;

-- 2. Batch RPC: one transaction per call. --------------------------------

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

grant execute on function public.reconcile_open_bottles_batch(jsonb) to authenticated;

-- === 0019_wine_published_list_slugs.sql ===
-- 0019_wine_published_list_slugs.sql — ARCH-019
-- Stable SQL RPC that returns the slugs of every published wine list
-- that references a given wine. Used by PATCH /api/wines/[id]/availability
-- to revalidate the public /list/[slug] pages after a 86 / restore.
--
-- Replaces an in-line PostgREST nested !inner filter, which was
-- PostgREST-version-fragile: a syntax change in the filter operator
-- would have broken revalidation silently.

create or replace function public.wine_published_list_slugs(
  p_wine_id uuid,
  p_restaurant_id uuid
) returns table (slug text)
language sql
stable
security definer
set search_path = public
as $$
  select distinct wl.slug
  from public.wine_lists wl
  join public.wine_list_sections s on s.wine_list_id = wl.id
  join public.wine_list_items i on i.section_id = s.id
  where i.wine_id = p_wine_id
    and wl.restaurant_id = p_restaurant_id
    and wl.is_published = true
    and wl.slug is not null
    and public.is_member(p_restaurant_id);
$$;

grant execute on function public.wine_published_list_slugs(uuid, uuid) to authenticated;

-- === 0020_schedule_cleanup_scan_idempotency.sql ===
-- 0020_schedule_cleanup_scan_idempotency.sql — INT-013
--
-- scan_idempotency rows TTL at 24h (cleanup_scan_idempotency() was
-- added in 0011) but nothing ever called the function, so the table
-- grew unbounded in production. This migration enables pg_cron (in
-- Supabase's `extensions` schema — the Supabase convention) and
-- schedules an hourly run.
--
-- The 24h TTL + hourly sweep means at most 25 hours of idempotency
-- keys are ever live — sufficient overlap for network retries but
-- bounded storage for any tenant.

create extension if not exists pg_cron with schema extensions;

-- Schedule hourly at :05 so the job doesn't collide with Supabase's
-- own top-of-hour maintenance sweeps. 'idempotent' schedule name —
-- re-running this migration is safe (cron.schedule upserts by name).
select cron.schedule(
  'cleanup_scan_idempotency_hourly',
  '5 * * * *',
  $$select public.cleanup_scan_idempotency();$$
);

-- === 0021_auto_eightysix.sql ===
-- 0021_auto_eightysix.sql — BND-037b
--
-- Auto-86 a wine when its total inventory (open + sealed) drops below
-- a configurable threshold. Unblocked by BND-038's pour tracking.
-- Closes the 86'd loop: BND-037 (manual 86) + BND-038 (oz-accurate
-- depletion) + this bundle's trigger = sommelier never has to touch
-- the 86 button for run-out scenarios.
--
-- Policy choices:
--  - OFF by default per restaurant. Manager opts in from /availability.
--  - Threshold is per-restaurant, default 148 ml (≈ 5 oz = one glass).
--    A wine is auto-86'd when it has less than one full glass
--    remaining across its open bottle + sealed stock.
--  - Never auto-RESTORES. Restock is an inventory_items write that
--    doesn't flow through pour_events; restoration stays a manager
--    action.
--  - Records the event in availability_events with user_id=null and
--    note='auto: below threshold' so the audit ledger shows the
--    trigger was the actor, not a human.

alter table public.restaurants
  add column auto_eightysix_from_inventory boolean not null default false,
  add column eightysix_ml_threshold int not null default 148
    check (eightysix_ml_threshold >= 0);

comment on column public.restaurants.auto_eightysix_from_inventory is
  'BND-037b: when true, a pour that drops total wine inventory below eightysix_ml_threshold auto-86s the wine.';
comment on column public.restaurants.eightysix_ml_threshold is
  'BND-037b: per-restaurant threshold in ml. Default 148 ml ≈ 5 oz (one glass pour).';

-- Trigger function: runs AFTER every pour_events insert (after the
-- existing apply-state trigger has updated open_bottles). Reads the
-- post-pour state, and if total drops below threshold with auto-86
-- enabled, flips wines.is_eightysixed + logs the availability_events
-- row.
create or replace function public.auto_eightysix_on_low_inventory()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_enabled              boolean;
  v_threshold            int;
  v_size_ml              int;
  v_already_eightysixed  boolean;
  v_open_ml              int;
  v_sealed_total_ml      int;
  v_total_ml             int;
begin
  -- Only pour-like events drain inventory. new_bottle adds state;
  -- reconcile is a manager correction that shouldn't cascade to
  -- 86 semantics (the manager saw the bottle and decided).
  if NEW.kind not in ('pour', 'spill', 'finish_bottle') then
    return NEW;
  end if;

  -- Restaurant config.
  select r.auto_eightysix_from_inventory, r.eightysix_ml_threshold
    into v_enabled, v_threshold
  from public.restaurants r
  where r.id = NEW.restaurant_id;

  if not v_enabled then
    return NEW;
  end if;

  -- Current wine state. Skip if already 86'd — no double-logging.
  select w.is_eightysixed, w.size_ml
    into v_already_eightysixed, v_size_ml
  from public.wines w
  where w.id = NEW.wine_id;

  if v_already_eightysixed then
    return NEW;
  end if;

  -- Post-pour open + sealed inventory.
  select coalesce(ob.remaining_ml, 0) into v_open_ml
  from public.open_bottles ob
  where ob.wine_id = NEW.wine_id and ob.restaurant_id = NEW.restaurant_id;

  select coalesce(sum(ii.quantity * v_size_ml), 0)::int
    into v_sealed_total_ml
  from public.inventory_items ii
  where ii.wine_id = NEW.wine_id and ii.restaurant_id = NEW.restaurant_id;

  v_total_ml := v_open_ml + coalesce(v_sealed_total_ml, 0);

  if v_total_ml < v_threshold then
    update public.wines
      set is_eightysixed = true,
          eightysixed_at = now(),
          eightysixed_by = null
    where id = NEW.wine_id and is_eightysixed = false;

    insert into public.availability_events
      (wine_id, restaurant_id, direction, user_id, note)
    values
      (NEW.wine_id, NEW.restaurant_id, 'eightysixed', null, 'auto: below threshold');
  end if;

  return NEW;
end;
$$;

-- IMPORTANT: trigger ordering. Postgres runs AFTER triggers on the
-- same event in alphabetical order by trigger name. The existing
-- apply-state trigger from 0016 is named `pour_events_trigger`; this
-- new trigger must sort AFTER it so it sees the post-pour open_bottles
-- state. Naming `pour_events_trigger_auto_eightysix` ensures the
-- '_auto_eightysix' suffix pushes this one later in the sort order.
create trigger pour_events_trigger_auto_eightysix
  after insert on public.pour_events
  for each row execute function public.auto_eightysix_on_low_inventory();

-- === 0022_auto_eightysix_owner_only.sql ===
-- INT-019 (high): close the manager-bypass on the BND-037b auto-86 columns.
--
-- Migration 0021 added two columns to `restaurants`:
--   auto_eightysix_from_inventory boolean
--   eightysix_ml_threshold        int
--
-- The pre-existing `restaurants` RLS UPDATE policy admits
-- role IN ('owner','manager'), which means these new columns inherit
-- that grant. /api/restaurant/[id] PATCH uses requireOwner() at the
-- HTTP layer, but nothing stops a manager from writing these columns
-- by calling Supabase directly with their own access token — bypassing
-- the HTTP-layer owner check.
--
-- Enforcement: BEFORE UPDATE trigger.
--
-- IMPORTANT — why not column-level REVOKE:
--   Postgres column-level `REVOKE UPDATE (col) ON tbl FROM role` is a
--   no-op when the original grant was table-level (Supabase's
--   bootstrap `GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated`).
--   The REVOKE only "subtracts" from matching column-level grants; with
--   no column-level grant to subtract from, the table-level grant wins.
--   Confirmed empirically against this DB — even after migration 0015's
--   REVOKE on wines availability columns, `has_column_privilege(
--   'authenticated', 'public.wines', 'is_eightysixed', 'UPDATE')` still
--   returns true. Migration 0015 is enforced only by the RLS policy
--   + the set_wine_availability RPC being the app's only sane write
--   path — the REVOKE is effectively documentation. (Separate finding
--   logged as DEBT-023 for follow-up.)
--
-- Trigger approach verified against this DB:
--   - Manager direct UPDATE of auto_eightysix_from_inventory → 42501 ✓
--   - Owner direct UPDATE → succeeds ✓
--   - Manager `name`-only UPDATE → succeeds (IS DISTINCT FROM no-op) ✓

create or replace function public.enforce_owner_for_auto_eightysix_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- No-op unless the auto-86 columns are actually changing. Managers
  -- updating `name` only (a legitimate flow) pass through cleanly.
  if new.auto_eightysix_from_inventory is not distinct from old.auto_eightysix_from_inventory
     and new.eightysix_ml_threshold is not distinct from old.eightysix_ml_threshold then
    return new;
  end if;

  -- postgres / service_role / other superuser contexts bypass. These
  -- are backend/cron/admin paths we trust. Only app callers (roles
  -- `authenticated` and `anon`) must satisfy the owner check.
  --
  -- NOTE: this function is deliberately NOT SECURITY DEFINER — we
  -- need current_user to reflect the real caller. A SECURITY DEFINER
  -- trigger function would always see current_user='postgres' and
  -- would bypass the check entirely.
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if not public.is_member_with_role(new.id, 'owner'::public.membership_role) then
    raise exception 'owner role required to modify auto-86 settings'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists restaurants_enforce_owner_for_auto_eightysix on public.restaurants;
create trigger restaurants_enforce_owner_for_auto_eightysix
  before update on public.restaurants
  for each row
  execute function public.enforce_owner_for_auto_eightysix_update();

comment on function public.enforce_owner_for_auto_eightysix_update() is
  'INT-019: BEFORE UPDATE enforcement for the BND-037b auto-86 columns on restaurants. Raises 42501 when anyone who is not a restaurant owner tries to change auto_eightysix_from_inventory or eightysix_ml_threshold via role `authenticated`/`anon`. No-op when the columns are unchanged. Superuser bypass (postgres/service_role) for backend maintenance paths.';

-- === 0023_wines_availability_owner_manager_trigger.sql ===
-- DEBT-023: close the staff-bypass on the BND-037 wine availability columns.
--
-- Migration 0015 added three columns to `wines`:
--   is_eightysixed  boolean
--   eightysixed_at  timestamptz
--   eightysixed_by  uuid
--
-- and tried to protect them with a column-level
-- `REVOKE UPDATE (col) ON public.wines FROM authenticated`. Per the
-- note in migration 0022 (INT-019): column-level REVOKE is a no-op
-- when the original grant was table-level (Supabase bootstraps
-- `GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated`). The
-- REVOKE only subtracts from matching column-level grants; with none
-- to subtract from, the table-level grant wins. Confirmed empirically
-- against this DB — `has_column_privilege('authenticated',
-- 'public.wines', 'is_eightysixed', 'UPDATE')` still returns true
-- after 0015. So today migration 0015 is enforced only by the
-- `set_wine_availability` RPC being the app's only sane write path
-- plus the `members can update their wines` RLS policy — but any
-- staff-role member who calls Supabase directly with their token can
-- UPDATE these columns and bypass audit logging.
--
-- Enforcement: BEFORE UPDATE trigger, mirroring 0022.
--
-- DIFFERENCE vs 0022: the legitimate write path
-- (`set_wine_availability` RPC + `/api/wines/[id]/availability`)
-- admits BOTH `owner` AND `manager`. So the gate here is
-- `is_member_with_role(..., 'owner') OR is_member_with_role(..., 'manager')`.
-- Auto-86 on restaurants (0022) is owner-only; manual 86/restore on
-- wines is owner-or-manager.
--
-- NOTE on the RPC write path: `set_wine_availability` is
-- SECURITY DEFINER, so inside it current_user='postgres'. This trigger
-- short-circuits on the `current_user NOT IN ('authenticated','anon')`
-- guard, so the RPC continues to write the three columns normally.
-- The trigger ONLY blocks direct-UPDATE bypass via the Supabase client.

create or replace function public.enforce_owner_or_manager_for_wine_availability_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- No-op unless the availability columns are actually changing. Staff
  -- updating `name` / `producer` / etc. (legitimate flows permitted by
  -- the wines RLS UPDATE policy) pass through cleanly.
  if new.is_eightysixed is not distinct from old.is_eightysixed
     and new.eightysixed_at is not distinct from old.eightysixed_at
     and new.eightysixed_by is not distinct from old.eightysixed_by then
    return new;
  end if;

  -- postgres / service_role / other superuser contexts bypass. These
  -- are backend/cron/admin paths we trust, including the
  -- `set_wine_availability` SECURITY DEFINER RPC which runs as
  -- `postgres`. Only app callers (roles `authenticated` and `anon`)
  -- must satisfy the owner-or-manager check.
  --
  -- NOTE: this function is deliberately NOT SECURITY DEFINER — we
  -- need current_user to reflect the real caller. A SECURITY DEFINER
  -- trigger function would always see current_user='postgres' and
  -- would bypass the check entirely.
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  -- `new.restaurant_id` because wines.id is the wine UUID; membership
  -- is checked against the wine's restaurant.
  if not (public.is_member_with_role(new.restaurant_id, 'owner'::public.membership_role)
          or public.is_member_with_role(new.restaurant_id, 'manager'::public.membership_role)) then
    raise exception 'owner or manager role required to modify wine availability'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists wines_enforce_owner_manager_for_availability on public.wines;
create trigger wines_enforce_owner_manager_for_availability
  before update on public.wines
  for each row
  execute function public.enforce_owner_or_manager_for_wine_availability_update();

comment on function public.enforce_owner_or_manager_for_wine_availability_update() is
  'DEBT-023: BEFORE UPDATE enforcement for the BND-037 wine availability columns on wines. Raises 42501 when anyone who is not a restaurant owner or manager tries to change is_eightysixed / eightysixed_at / eightysixed_by via role `authenticated`/`anon`. No-op when the columns are unchanged. Superuser bypass (postgres/service_role) preserves the `set_wine_availability` SECURITY DEFINER RPC write path. Replaces the misleading column-level REVOKE in migration 0015 (Postgres no-op when bootstrap grant is table-level).';

-- === 0024_document_wines_availability_enforcement.sql ===
-- DEBT-023 cleanup (~5 min housekeeping).
--
-- Migration 0015 shipped a column-level REVOKE on
-- is_eightysixed, eightysixed_at, eightysixed_by from authenticated,
-- labelled as the "integrity guard." It turns out Postgres column-
-- level REVOKE is a no-op when the underlying grant is table-level
-- (Supabase's bootstrap does GRANT ALL ON ALL TABLES IN SCHEMA
-- public TO authenticated — a table-level grant with no per-column
-- ACL rows, so there's nothing for a column-level REVOKE to
-- subtract from). Empirically confirmed:
--   has_column_privilege('authenticated', 'public.wines',
--                        'is_eightysixed', 'UPDATE')
-- still returns true, and pg_attribute.attacl for the three
-- columns is NULL.
--
-- The actual enforcement of "only owner or manager can change
-- availability" is migration 0023's BEFORE UPDATE trigger
-- wines_enforce_owner_manager_for_availability. Legitimate writes
-- go through the set_wine_availability SECURITY DEFINER RPC
-- (migration 0015), which runs as postgres and therefore bypasses
-- the trigger via current_user check.
--
-- Migrations are immutable once shipped, so we can't edit 0015 to
-- remove its misleading REVOKE statement. This migration doesn't
-- change any runtime behavior. What it does:
--
--   1. Adds COMMENT ON COLUMN annotations so future readers
--      understand where availability enforcement actually lives
--      (0023 trigger + 0015 RPC) without having to reconstruct
--      the finding from a diff search.
--
--   2. Stands as a paper-trail entry recording that 0015's REVOKE
--      was decorative. If anyone greps for "revoke update" in
--      wines-related migrations, they land here next.

comment on column public.wines.is_eightysixed is
  $$BND-037: whether this wine is 86'd (out of stock or paused). Legitimate writes go through the set_wine_availability RPC (migration 0015, SECURITY DEFINER with internal owner-or-manager check). Direct UPDATE by role authenticated / anon is blocked by the wines_enforce_owner_manager_for_availability BEFORE UPDATE trigger (migration 0023). The column-level REVOKE in 0015 is a Postgres no-op against Supabase's table-level GRANT ALL and does not contribute to enforcement — see DEBT-023 / migration 0024 docstring.$$;

comment on column public.wines.eightysixed_at is
  $$BND-037: when this wine was 86'd. Null unless is_eightysixed = true. Enforcement path is identical to is_eightysixed — see its column comment.$$;

comment on column public.wines.eightysixed_by is
  $$BND-037: user who 86'd this wine. Null for auto-86 events (migration 0021 trigger sets user_id = null in availability_events; wines.eightysixed_by stays null too when the auto path fires) and when is_eightysixed = false. Enforcement path is identical to is_eightysixed — see its column comment.$$;

-- === 0025_drink_window_metadata.sql ===
-- BND-039 — Drink window metadata (the drink-window intelligence feature).
--
-- Schema additions: enrichment provenance + alert snooze. drink_window_start
-- and drink_window_end already exist (since 0014 era).
--
-- All columns nullable so existing wines render gracefully without
-- enrichment data. The UI surfaces degrade — no panel rendered if
-- drink_window_end is null.
--
-- This migration was applied via the Supabase MCP `apply_migration`
-- on 2026-04-26 against project qcfmwphlaekfkqwkfyth (terroir prod).
-- The local file exists for git history + future regen reproducibility.
--
-- DOWN (manual):
--   ALTER TABLE public.wines
--     DROP COLUMN peak_year,
--     DROP COLUMN rating,
--     DROP COLUMN rating_source,
--     DROP COLUMN review_excerpt,
--     DROP COLUMN last_enriched_at,
--     DROP COLUMN alert_snoozed_until;
--   DROP FUNCTION IF EXISTS public.snooze_drink_window_alert(uuid, int);
--   (revert enrich_wines_batch by re-running 0014's body)

ALTER TABLE public.wines
  ADD COLUMN peak_year           smallint,
  ADD COLUMN rating              smallint,
  ADD COLUMN rating_source       text,
  ADD COLUMN review_excerpt      text,
  ADD COLUMN last_enriched_at    timestamptz,
  ADD COLUMN alert_snoozed_until timestamptz;

ALTER TABLE public.wines
  ADD CONSTRAINT wines_rating_range
    CHECK (rating IS NULL OR (rating >= 0 AND rating <= 100)),
  ADD CONSTRAINT wines_peak_year_range
    CHECK (peak_year IS NULL OR (peak_year >= 1900 AND peak_year <= 2100));

COMMENT ON COLUMN public.wines.rating_source IS
  'BND-039 provenance of enrichment data. Allowed: rule_engine | claude_inference | vinous | parker | js | wine_spectator | decanter | aggregate. Validated in app layer (not a DB enum so adding sources is migration-free).';

COMMENT ON COLUMN public.wines.alert_snoozed_until IS
  'BND-039: per-wine snooze for the Insights drink-window briefing alert. NULL = not snoozed. 30-day default set by /api/wines/[id]/snooze-alert.';

-- Update enrich_wines_batch RPC to accept the new fields. Backwards-compatible:
-- the jsonb payload may or may not include new keys; absent keys leave the
-- existing row value untouched (coalesce). Old callers keep working.

create or replace function public.enrich_wines_batch(
  p_restaurant_id uuid,
  p_enrichments   jsonb
) returns int
language plpgsql
security invoker
as $$
declare
  v_count int;
begin
  if p_enrichments is null or jsonb_typeof(p_enrichments) <> 'array' or jsonb_array_length(p_enrichments) = 0 then
    return 0;
  end if;

  with u as (
    select
      (e->>'id')::uuid                  as id,
      (e->>'drink_window_start')::int    as drink_window_start,
      (e->>'drink_window_end')::int      as drink_window_end,
      (e->>'peak_year')::int             as peak_year,
      (e->>'rating')::int                as rating,
      (e->>'rating_source')              as rating_source,
      (e->>'review_excerpt')             as review_excerpt,
      (e->>'serving_temp_min')::int      as serving_temp_min,
      (e->>'serving_temp_max')::int      as serving_temp_max,
      (e->>'serving_temp_label')         as serving_temp_label
    from jsonb_array_elements(p_enrichments) as e
  )
  update public.wines w
  set
    drink_window_start = coalesce(u.drink_window_start, w.drink_window_start),
    drink_window_end   = coalesce(u.drink_window_end,   w.drink_window_end),
    peak_year          = coalesce(u.peak_year,          w.peak_year),
    rating             = coalesce(u.rating,             w.rating),
    rating_source      = coalesce(u.rating_source,      w.rating_source),
    review_excerpt     = coalesce(u.review_excerpt,     w.review_excerpt),
    serving_temp_min   = coalesce(u.serving_temp_min,   w.serving_temp_min),
    serving_temp_max   = coalesce(u.serving_temp_max,   w.serving_temp_max),
    serving_temp_label = coalesce(u.serving_temp_label, w.serving_temp_label),
    last_enriched_at   = now()
  from u
  where w.id = u.id
    and w.restaurant_id = p_restaurant_id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.enrich_wines_batch(uuid, jsonb) is
  'BND-031 + BND-039: atomic batch enrichment of wines including drink window, serving temp, and rating metadata. Returns the number of rows updated.';

-- Snooze alert RPC — separate from enrich_wines_batch because it has
-- different auth gating (owner+manager only, matched via app-level
-- requireMembership; not enforced via trigger because it's a low-stakes
-- UX state, not security-critical).

create or replace function public.snooze_drink_window_alert(
  p_wine_id uuid,
  p_days    int default 30
) returns timestamptz
language plpgsql
security invoker
as $$
declare
  v_until timestamptz;
begin
  v_until := now() + make_interval(days => p_days);

  update public.wines
  set alert_snoozed_until = v_until
  where id = p_wine_id;

  if not found then
    raise exception 'wine not found' using errcode = 'P0002';
  end if;

  return v_until;
end;
$$;

comment on function public.snooze_drink_window_alert(uuid, int) is
  'BND-039: snooze the drink-window alert for a wine. Default 30 days. Owner+manager gating enforced at the API layer via requireMembership.';

-- === 0026_pricing_intelligence_metadata.sql ===
-- BND-040 — Pricing Intelligence (Layer A market benchmark + Layer C heuristic recs).
--
-- Schema additions:
--   restaurants: house targets (default 22% pour cost, 2.7× bottle markup)
--   wines: per-wine target overrides + Wine-Searcher retail cache + dismissal snooze
--
-- All new columns nullable so existing wines/restaurants render gracefully
-- without pricing data. UI surfaces degrade — no panel rendered if retail
-- cache is empty. Defaults seeded on restaurants.
--
-- This migration was applied via Supabase MCP `apply_migration` on
-- 2026-04-26 against project qcfmwphlaekfkqwkfyth (terroir prod). The
-- local file exists for git history + future regen reproducibility.
--
-- DOWN (manual):
--   ALTER TABLE public.restaurants
--     DROP COLUMN default_target_pour_cost_pct,
--     DROP COLUMN default_target_markup_ratio;
--   ALTER TABLE public.wines
--     DROP COLUMN pricing_target_pour_cost_pct,
--     DROP COLUMN pricing_target_markup_ratio,
--     DROP COLUMN pricing_dismissed_until,
--     DROP COLUMN retail_min,
--     DROP COLUMN retail_max,
--     DROP COLUMN retail_median,
--     DROP COLUMN retail_retailer_count,
--     DROP COLUMN retail_refreshed_at;
--   DROP INDEX IF EXISTS public.wines_retail_refreshed_at_idx;
--   DROP FUNCTION IF EXISTS public.dismiss_pricing_alert(uuid, int);

-- House-level pricing targets (defaults applied to all wines unless overridden)
ALTER TABLE public.restaurants
  ADD COLUMN default_target_pour_cost_pct  numeric(5,2)  DEFAULT 22.00,
  ADD COLUMN default_target_markup_ratio   numeric(4,2)  DEFAULT 2.70;

ALTER TABLE public.restaurants
  ADD CONSTRAINT restaurants_target_pour_cost_pct_range
    CHECK (default_target_pour_cost_pct IS NULL OR (default_target_pour_cost_pct > 0 AND default_target_pour_cost_pct < 100)),
  ADD CONSTRAINT restaurants_target_markup_ratio_range
    CHECK (default_target_markup_ratio IS NULL OR (default_target_markup_ratio >= 1 AND default_target_markup_ratio <= 10));

COMMENT ON COLUMN public.restaurants.default_target_pour_cost_pct IS
  'BND-040: house-level target pour cost % for glass pricing. Default 22%. Range 0-100.';
COMMENT ON COLUMN public.restaurants.default_target_markup_ratio IS
  'BND-040: house-level target bottle markup multiplier (vs retail). Default 2.7×. Range 1-10.';

-- Per-wine targets (overrides house defaults) + Wine-Searcher retail cache + snooze
ALTER TABLE public.wines
  ADD COLUMN pricing_target_pour_cost_pct  numeric(5,2),
  ADD COLUMN pricing_target_markup_ratio   numeric(4,2),
  ADD COLUMN pricing_dismissed_until       timestamptz,
  ADD COLUMN retail_min                    numeric(10,2),
  ADD COLUMN retail_max                    numeric(10,2),
  ADD COLUMN retail_median                 numeric(10,2),
  ADD COLUMN retail_retailer_count         smallint,
  ADD COLUMN retail_refreshed_at           timestamptz;

ALTER TABLE public.wines
  ADD CONSTRAINT wines_pricing_target_pour_cost_pct_range
    CHECK (pricing_target_pour_cost_pct IS NULL OR (pricing_target_pour_cost_pct > 0 AND pricing_target_pour_cost_pct < 100)),
  ADD CONSTRAINT wines_pricing_target_markup_ratio_range
    CHECK (pricing_target_markup_ratio IS NULL OR (pricing_target_markup_ratio >= 1 AND pricing_target_markup_ratio <= 10)),
  ADD CONSTRAINT wines_retail_min_max_order
    CHECK (retail_min IS NULL OR retail_max IS NULL OR retail_min <= retail_max),
  ADD CONSTRAINT wines_retail_retailer_count_nonneg
    CHECK (retail_retailer_count IS NULL OR retail_retailer_count >= 0);

COMMENT ON COLUMN public.wines.pricing_target_pour_cost_pct IS
  'BND-040: per-wine pour cost % override. NULL = inherit restaurant default. Allows allocation wines (Krug, DRC) to have custom targets.';
COMMENT ON COLUMN public.wines.pricing_target_markup_ratio IS
  'BND-040: per-wine markup multiplier override. NULL = inherit restaurant default OR category band.';
COMMENT ON COLUMN public.wines.pricing_dismissed_until IS
  'BND-040: per-wine snooze for the Insights pricing-review alert. NULL = not snoozed. 30-day default mirrors alert_snoozed_until pattern.';
COMMENT ON COLUMN public.wines.retail_median IS
  'BND-040: median retail price across Wine-Searcher retailers. Refreshed weekly via /api/wines/[id]/refresh-retail. NULL = no data yet (wine not enriched OR Wine-Searcher API unavailable).';

-- Index on retail_refreshed_at to make "find wines that need re-fetch" queries cheap.
CREATE INDEX IF NOT EXISTS wines_retail_refreshed_at_idx
  ON public.wines (restaurant_id, retail_refreshed_at)
  WHERE retail_refreshed_at IS NOT NULL;

-- Snooze alert RPC for pricing dismissals (mirrors snooze_drink_window_alert).
CREATE OR REPLACE FUNCTION public.dismiss_pricing_alert(
  p_wine_id uuid,
  p_days    int DEFAULT 30
) RETURNS timestamptz
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_until timestamptz;
BEGIN
  v_until := now() + make_interval(days => p_days);

  UPDATE public.wines
  SET pricing_dismissed_until = v_until
  WHERE id = p_wine_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'wine not found' USING ERRCODE = 'P0002';
  END IF;

  RETURN v_until;
END;
$$;

COMMENT ON FUNCTION public.dismiss_pricing_alert(uuid, int) IS
  'BND-040: dismiss the pricing-review alert for a wine. Default 30 days. Owner+manager gating enforced at the API layer via requireMembership.';

-- === 0027_invitations_email_required.sql ===
-- BND-011 — Bind invitations to email (closes INT-005).
--
-- Producer (invite POST) currently lets `email` default to NULL; consumer
-- (accept POST) silently accepts any authed user. This migration enforces
-- the producer-consumer invariant at the schema level so it cannot drift:
-- the column becomes NOT NULL, and the application layer is updated in the
-- same bundle (invite POST persists Zod-validated email; accept POST
-- compares case-insensitively and returns opaque 404 on mismatch).
--
-- DEFENSIVE GUARD: the DO block aborts loudly with a clear message if any
-- unexpected NULL rows exist, instead of silently destroying data.
--
-- DATA CLEANUP (one-time, 2026-04-27): the bundle author predicted DEMO
-- would have no NULL-email rows, but production had a small number of
-- pre-email-tracking legacy invitations. They were removed manually
-- before this migration applied via:
--
--   DELETE FROM public.invitations WHERE email IS NULL;
--
-- (run inside the same transaction as the migration). Future production
-- environments that re-apply this migration must perform the same
-- cleanup if any NULL rows still exist.
--
-- This migration is intended to be applied via Supabase MCP
-- `apply_migration` against project qcfmwphlaekfkqwkfyth (terroir prod).
-- See `.council/runbooks/database-backup.md` for the pre-migration backup
-- procedure (run a manual db-backup workflow trigger before any
-- production migration that touches data-bearing tables).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.invitations WHERE email IS NULL) THEN
    RAISE EXCEPTION
      'Refusing to apply 0027: NULL email rows exist in public.invitations. Operator must populate or delete them before re-running.';
  END IF;
END $$;

ALTER TABLE public.invitations
  ALTER COLUMN email SET NOT NULL;

-- === 0028_wine_lists_description.sql ===
-- Add description column to wine_lists for feature #153
alter table public.wine_lists
  add column description text;

-- === 0029_public_restaurant_read.sql ===
-- 0029_public_restaurant_read.sql
-- Allow anonymous (public) users to read restaurant names when they have
-- published wine lists. This enables the /list/[slug] SSR page to display
-- the restaurant name via the anon key nested embed (restaurants(name)).

create policy "public can read restaurants with published lists"
  on public.restaurants for select to anon
  using (
    exists (
      select 1
      from public.wine_lists wl
      where wl.restaurant_id = restaurants.id
        and wl.is_published = true
    )
  );

-- Also create a down migration

-- === 0030_wine_lists_archived.sql ===
-- Add archived column to wine_lists for feature #158
alter table public.wine_lists
  add column archived boolean not null default false;

-- === 0031_wine_list_items_name_override.sql ===
-- BND-169: add name_override column to wine_list_items
alter table public.wine_list_items
  add column if not exists name_override text;

-- === 0032_wine_list_items_blurb.sql ===
-- BND-170: add blurb column to wine_list_items for custom per-item text
alter table public.wine_list_items
  add column if not exists blurb text;

-- === 0033_wine_list_items_hidden.sql ===
-- BND-171: add hidden column to wine_list_items to exclude from public views
alter table public.wine_list_items
  add column if not exists hidden boolean not null default false;

-- === 0034_eightysix_strategy.sql ===
-- 0034_eightysix_strategy.sql
-- Add eightysix_strategy column to restaurants to control how 86d wines
-- appear on published wine lists:
--   'hide' (default) -- 86d wines are removed from /list/[slug]
--   'mark'           -- 86d wines are shown with gray/strikethrough styling

alter table public.restaurants
  add column eightysix_strategy text not null default 'hide'
  check (eightysix_strategy in ('hide', 'mark'));

-- === 0035_restaurant_logo_url.sql ===
-- 0035_restaurant_logo_url.sql
-- Add logo_url column to restaurants

alter table public.restaurants
  add column logo_url text;

-- === 0036_cellar_config_low_stock_threshold.sql ===
alter table public.cellar_config add column low_stock_threshold integer not null default 3;
-- === 0037_wines_enrichment_metadata.sql ===
-- BND-261 (feature #74) enrichment_metadata on wines.
--
-- Adds a jsonb column to track per-wine enrichment provenance.
-- Updates enrich_wines_batch to accept and store enrichment_metadata.

ALTER TABLE public.wines
  ADD COLUMN enrichment_metadata jsonb;

COMMENT ON COLUMN public.wines.enrichment_metadata IS
  'Per-wine enrichment provenance: { source, fields_enriched, enriched_at }. Set by enrich_wines_batch.';

create or replace function public.enrich_wines_batch(
  p_restaurant_id uuid,
  p_enrichments   jsonb
) returns int
language plpgsql
security invoker
as $$
declare
  v_count int;
begin
  if p_enrichments is null or jsonb_typeof(p_enrichments) <> 'array' or jsonb_array_length(p_enrichments) = 0 then
    return 0;
  end if;

  with u as (
    select
      (e->>'id')::uuid                  as id,
      (e->>'drink_window_start')::int    as drink_window_start,
      (e->>'drink_window_end')::int      as drink_window_end,
      (e->>'peak_year')::int             as peak_year,
      (e->>'rating')::int                as rating,
      (e->>'rating_source')              as rating_source,
      (e->>'review_excerpt')             as review_excerpt,
      (e->>'serving_temp_min')::int      as serving_temp_min,
      (e->>'serving_temp_max')::int      as serving_temp_max,
      (e->>'serving_temp_label')         as serving_temp_label,
      (e->'enrichment_metadata')         as enrichment_metadata
    from jsonb_array_elements(p_enrichments) as e
  )
  update public.wines w
  set
    drink_window_start = coalesce(u.drink_window_start, w.drink_window_start),
    drink_window_end   = coalesce(u.drink_window_end,   w.drink_window_end),
    peak_year          = coalesce(u.peak_year,          w.peak_year),
    rating             = coalesce(u.rating,             w.rating),
    rating_source      = coalesce(u.rating_source,      w.rating_source),
    review_excerpt     = coalesce(u.review_excerpt,     w.review_excerpt),
    serving_temp_min   = coalesce(u.serving_temp_min,   w.serving_temp_min),
    serving_temp_max   = coalesce(u.serving_temp_max,   w.serving_temp_max),
    serving_temp_label = coalesce(u.serving_temp_label, w.serving_temp_label),
    last_enriched_at   = now(),
    enrichment_metadata = coalesce(u.enrichment_metadata, w.enrichment_metadata)
  from u
  where w.id = u.id
    and w.restaurant_id = p_restaurant_id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.enrich_wines_batch(uuid, jsonb) is
  'BND-031 BND-039 BND-261: atomic batch enrichment with provenance. Returns rows updated.';

-- === 0038.sql ===
-- 0038_pour_events_open_bottle_id.sql -- BND-117, BND-119
-- Adds open_bottle_id to pour_events for direct bottle-to-events linkage.
-- This enables undo-last-pour by finding the most recent pour_event
-- for a specific open bottle and reversing it.
--
-- Also updates record_pour and reconcile_open_bottle RPCs to populate
-- the new column.

-- 1. Add open_bottle_id column

alter table public.pour_events
  add column open_bottle_id uuid references public.open_bottles(id) on delete set null;

comment on column public.pour_events.open_bottle_id is
  'The open_bottle this event was recorded against. NULL for new_bottle events.';

create index pour_events_open_bottle_occurred_idx
  on public.pour_events (open_bottle_id, occurred_at desc);

-- 2. Replace record_pour to populate open_bottle_id

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
      raise exception 'TERROIR_OUT_OF_STOCK' using errcode = 'P0001';
    end if;

    update public.inventory_items
      set quantity = quantity - 1
      where id = v_sealed_item.id;

    insert into public.pour_events
      (wine_id, restaurant_id, ml_delta, kind, actor_user_id, note)
    values
      (p_wine_id, v_restaurant_id, -v_size_ml, 'new_bottle', v_user, p_note);

    -- Capture the new bottle id for the actual pour event.
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

grant execute on function public.record_pour(uuid, int, text, text) to authenticated;

-- 3. Replace reconcile_open_bottle to populate open_bottle_id

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

  select * into v_current
    from public.open_bottles
    where wine_id = p_wine_id and restaurant_id = v_restaurant_id;
  return v_current;
end;
$$;

grant execute on function public.reconcile_open_bottle(uuid, int, text) to authenticated;

-- 4. Replace reconcile_open_bottles_batch

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

grant execute on function public.reconcile_open_bottles_batch(jsonb) to authenticated;

-- === 0039_invoice_scans_status.sql ===
-- 0039_invoice_scans_status.sql -- BND-083
-- Adds status column to invoice_scans for async OCR processing tracking.
-- Status values: processing, complete, failed

alter table public.invoice_scans
  add column status text not null default 'processing';

comment on column public.invoice_scans.status is
  E'OCR processing status: processing, complete, or failed.';

create index invoice_scans_status_idx
  on public.invoice_scans (status);
-- === 0040_undo_last_pour.sql ===
-- 0040_undo_last_pour.sql -- BND-119
-- RPC to undo the most recent pour/spill event for a wine.
-- Deletes the latest pour_events row (kind=pour or spill) and adjusts
-- open_bottles.remaining_ml accordingly. Also inserts an availability_events
-- row to capture the undo action.

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
  -- Auth check: must be a member of this wine's restaurant.
  select restaurant_id into v_restaurant_id
    from public.wines where id = p_wine_id;
  if v_restaurant_id is null then
    raise exception 'wine not found';
  end if;

  if not public.is_member_with_role(v_restaurant_id, 'staff') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Find the most recent pour or spill event for this wine
  -- that has an open_bottle_id (i.e., was recorded against a specific bottle).
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

  -- Lock the current open_bottles row.
  select * into v_current
    from public.open_bottles
    where wine_id = p_wine_id and restaurant_id = v_restaurant_id
    for update;

  -- Restore the remaining_ml by adding back the poured amount.
  if v_current.id is not null then
    update public.open_bottles
      set remaining_ml = remaining_ml + v_event.ml_delta
      where id = v_current.id;
  else
    -- The bottle was finished; recreate the open_bottles row.
    -- remaining_ml is the ml that was poured (returned to the bottle).
    insert into public.open_bottles
      (wine_id, restaurant_id, remaining_ml, opened_by)
    values
      (p_wine_id, v_restaurant_id, v_event.ml_delta, v_event.actor_user_id);
  end if;

  -- Delete the pour event (the undo action).
  delete from public.pour_events
    where id = v_event.id;

  -- Insert an availability event to record the undo.
  insert into public.availability_events
    (wine_id, restaurant_id, direction, user_id, note)
  values
    (p_wine_id, v_restaurant_id, 'restored', v_user, 'undo pour: ' || v_event.ml_delta || 'ml restored');

  -- Return the updated open_bottles row.
  select * into v_current
    from public.open_bottles
    where wine_id = p_wine_id and restaurant_id = v_restaurant_id;
  return v_current;
end;
$$;

grant execute on function public.undo_last_pour(uuid) to authenticated;

-- === 0041_invoice_scans_ocr_created_by.sql ===
-- 0041_invoice_scans_ocr_created_by.sql -- BND-090
-- Adds ocr_text (jsonb) and created_by (uuid) to invoice_scans
-- for full scan audit trail with OCR metadata and user attribution.

alter table public.invoice_scans
  add column ocr_text jsonb,
  add column created_by uuid;

comment on column public.invoice_scans.ocr_text is
  E'Raw OCR result from Azure Document Intelligence stored as JSON.';

comment on column public.invoice_scans.created_by is
  E'User who initiated the scan (references auth.users).';

-- === 0042_invoice_scans_multi_page.sql ===
-- 0042_invoice_scans_multi_page.sql -- BND-081
alter table public.invoice_scans
  add column extra_image_paths jsonb not null default '[]'::jsonb;

-- === 0043_cellar_config_reconcile_variance_threshold.sql ===
-- 0043_cellar_config_reconcile_variance_threshold.sql
-- BND-134: Add reconcile_variance_threshold_oz to cellar_config so
-- restaurants can control when variance highlighting fires during
-- end-of-shift reconciliation. Default 1.0 oz strikes a balance
-- between noise (0.1 oz differences on every bottle) and insensitivity
-- (missing real discrepancies).
--
-- Variance = |expected_ml - actual_ml| / ML_PER_OZ (29.5735).
-- Rows with variance > threshold render in a warning color.

ALTER TABLE cellar_config
  ADD COLUMN reconcile_variance_threshold_oz numeric NOT NULL DEFAULT 1.0;

COMMENT ON COLUMN cellar_config.reconcile_variance_threshold_oz IS
  'Variance (oz) above which reconcile rows are visually flagged as suspicious.';

-- === 0044_open_bottles_closed_at.sql ===
-- 0044_open_bottles_closed_at.sql -- BND-114, BND-116
-- Adds closed_at to open_bottles so finished bottles persist with a
-- timestamp instead of being deleted. Enables audit trail for bottle
-- lifecycle: opened_at → closed_at.
--
-- Also updates pour_events_maintain_open_bottle trigger to set closed_at
-- instead of deleting drained rows, and resets closed_at when a
-- replacement bottle is opened.

-- 1. Add closed_at column

alter table public.open_bottles
  add column closed_at timestamptz;

comment on column public.open_bottles.closed_at is
  'When this bottle was finished (remaining_ml dropped to 0). NULL = bottle is still active.';

-- 2. Replace trigger: set closed_at instead of deleting drained rows

create or replace function public.pour_events_maintain_open_bottle()
returns trigger
language plpgsql
as $$
begin
  if NEW.kind = 'new_bottle' then
    -- ml_delta for new_bottle is negative = -size_ml; insert/replace open_bottles.
    -- Reset closed_at to null since this is a fresh bottle.
    insert into public.open_bottles
      (wine_id, restaurant_id, remaining_ml, opened_by, closed_at)
    values
      (NEW.wine_id, NEW.restaurant_id, -NEW.ml_delta, NEW.actor_user_id, null)
    on conflict (wine_id, restaurant_id)
    do update set
      remaining_ml = -NEW.ml_delta,
      opened_at = now(),
      opened_by = NEW.actor_user_id,
      closed_at = null;

  elsif NEW.kind in ('pour','spill','finish_bottle') then
    -- Positive ml_delta: subtract from remaining.
    update public.open_bottles
      set remaining_ml = greatest(0, remaining_ml - NEW.ml_delta)
      where wine_id = NEW.wine_id and restaurant_id = NEW.restaurant_id;
    -- If we drained it, close the bottle instead of deleting.
    update public.open_bottles
      set closed_at = now()
      where wine_id = NEW.wine_id and restaurant_id = NEW.restaurant_id
        and remaining_ml = 0
        and closed_at is null;

  elsif NEW.kind = 'reconcile' then
    -- Signed ml_delta: positive reduces, negative increases.
    update public.open_bottles
      set remaining_ml = greatest(0, remaining_ml - NEW.ml_delta)
      where wine_id = NEW.wine_id and restaurant_id = NEW.restaurant_id;
    -- Close if reconciled to zero.
    update public.open_bottles
      set closed_at = now()
      where wine_id = NEW.wine_id and restaurant_id = NEW.restaurant_id
        and remaining_ml = 0
        and closed_at is null;
  end if;
  return NEW;
end;
$$;
-- 3. Replace record_pour RPC with open_bottle_id + closed_at awareness.
-- The query for existing open bottle now filters for closed_at IS NULL
-- so finished bottles are ignored when looking for the active one.

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

grant execute on function public.record_pour(uuid, int, text, text) to authenticated;


-- 4. Replace reconcile_open_bottle to filter for active bottles only

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

  -- Only reconcile active (non-closed) bottles.
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

  select * into v_current
    from public.open_bottles
    where wine_id = p_wine_id and restaurant_id = v_restaurant_id;
  return v_current;
end;
$$;

grant execute on function public.reconcile_open_bottle(uuid, int, text) to authenticated;

-- 5. Replace reconcile_open_bottles_batch

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

grant execute on function public.reconcile_open_bottles_batch(jsonb) to authenticated;


-- 6. Replace list_open_bottle_items to exclude closed bottles

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
  left join public.open_bottles ob on ob.wine_id = w.id
                                    and ob.restaurant_id = p_restaurant_id
                                    and ob.closed_at is null
  where wl.restaurant_id = p_restaurant_id
    and wli.glass_pour_ml is not null
    and public.is_member(p_restaurant_id)
  order by w.producer, w.name;
$$;

grant execute on function public.list_open_bottle_items(uuid) to authenticated;

-- === 0045_inventory_items_section.sql ===
-- 0044_inventory_items_section.sql -- BND-109
-- Adds section column to inventory_items for bottle location tracking.

alter table public.inventory_items
  add column if not exists section text;

comment on column public.inventory_items.section is
  E'Cellar section where the bottle is stored (e.g., "Red Room", "Main Cellar").';

-- === 0046_reconcile_availability_events.sql ===
-- 0046_reconcile_availability_events.sql -- BND-129/130/131
-- Three changes for the reconcile feature set:
--
-- 1. Alter availability_events.direction check to include 'reconcile'
--    so end-of-shift corrections appear in the audit log alongside
--    86/restore events.
--
-- 2. Add delta column to availability_events (nullable int).
--    For reconcile events, delta = old_remaining - new_remaining
--    (positive = removing volume from the tracked bottle, negative =
--    adding volume, i.e., the bottle had more than expected).
--
-- 3. Replace reconcile_open_bottle to insert an availability_events
--    row (direction='reconcile', delta=v_delta) in the same transaction
--    as the pour_events row.

-- 1. Alter direction check constraint to include 'reconcile'. ---------------

alter table public.availability_events
  drop constraint availability_events_direction_check;

alter table public.availability_events
  add constraint availability_events_direction_check
    check (direction in ('eightysixed', 'restored', 'reconcile'));

-- 2. Add delta column (nullable). -------------------------------------------

alter table public.availability_events
  add column delta int;

comment on column public.availability_events.delta is
  'Reconcile: old_remaining_ml - new_remaining_ml. Null for 86/restore events.';

-- 3. Replace reconcile_open_bottle with availability_events insert. ---------

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

  -- Only reconcile active (non-closed) bottles.
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

  -- BND-131: also insert an availability_events row for the audit log.
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

grant execute on function public.reconcile_open_bottle(uuid, int, text) to authenticated;

-- === 0046_wines_tasting_notes_hero_image.sql ===
-- 0046_wines_tasting_notes_hero_image.sql
-- BND-055 + BND-056 + BND-057: add tasting_notes and hero_image_url
-- to the wines table.

alter table public.wines
  add column if not exists tasting_notes text,
  add column if not exists hero_image_url text;

-- === 0047_wines_decant_minutes.sql ===
-- 0047_wines_decant_minutes.sql
-- BND-070: Add decant_minutes column to wines table and update
-- enrich_wines_batch to handle the new column.

-- 1. Add the column
ALTER TABLE wines
  ADD COLUMN decant_minutes integer;

COMMENT ON COLUMN wines.decant_minutes IS
  'BND-070 — recommended decant time in minutes. NULL when not applicable or not yet enriched.';

-- 2. Update enrich_wines_batch to extract and persist decant_minutes
CREATE OR REPLACE FUNCTION public.enrich_wines_batch(
  p_restaurant_id uuid,
  p_enrichments   jsonb
) RETURNS int
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_count int;
BEGIN
  IF p_enrichments IS NULL OR jsonb_typeof(p_enrichments) <> 'array' OR jsonb_array_length(p_enrichments) = 0 THEN
    RETURN 0;
  END IF;

  WITH u AS (
    SELECT
      (e->>'id')::uuid                  AS id,
      (e->>'drink_window_start')::int    AS drink_window_start,
      (e->>'drink_window_end')::int      AS drink_window_end,
      (e->>'peak_year')::int             AS peak_year,
      (e->>'rating')::numeric            AS rating,
      (e->>'rating_source')              AS rating_source,
      (e->>'review_excerpt')             AS review_excerpt,
      (e->>'serving_temp_min')::int      AS serving_temp_min,
      (e->>'serving_temp_max')::int      AS serving_temp_max,
      (e->>'serving_temp_label')         AS serving_temp_label,
      (e->>'decant_minutes')::int        AS decant_minutes,
      (e->>'enrichment_metadata')::jsonb AS enrichment_metadata
    FROM jsonb_array_elements(p_enrichments) AS e
  )
  UPDATE public.wines w
  SET
    drink_window_start = coalesce(u.drink_window_start, w.drink_window_start),
    drink_window_end   = coalesce(u.drink_window_end,   w.drink_window_end),
    peak_year          = coalesce(u.peak_year,          w.peak_year),
    rating             = coalesce(u.rating,             w.rating),
    rating_source      = coalesce(u.rating_source,      w.rating_source),
    review_excerpt     = coalesce(u.review_excerpt,     w.review_excerpt),
    serving_temp_min   = coalesce(u.serving_temp_min,   w.serving_temp_min),
    serving_temp_max   = coalesce(u.serving_temp_max,   w.serving_temp_max),
    serving_temp_label = coalesce(u.serving_temp_label, w.serving_temp_label),
    decant_minutes     = coalesce(u.decant_minutes,     w.decant_minutes),
    enrichment_metadata = coalesce(u.enrichment_metadata, w.enrichment_metadata),
    last_enriched_at   = now()
  FROM u
  WHERE w.id = u.id
    AND w.restaurant_id = p_restaurant_id;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.enrich_wines_batch(uuid, jsonb) IS
  'BND-031/BND-039/BND-070: atomic batch enrichment of wines including decant time. Returns the number of rows updated.';

-- === 0048_wines_manual_overrides.sql ===
-- 0048_wines_manual_overrides.sql
-- BND-277/BND-278: Add manual_overrides column to wines, create
-- add_manual_overrides RPC, and update enrich_wines_batch to skip
-- fields that have been manually overridden.

-- 1. Add manual_overrides column
ALTER TABLE public.wines
  ADD COLUMN manual_overrides text[] DEFAULT '{}';

COMMENT ON COLUMN public.wines.manual_overrides IS
  'BND-277/BND-278 -- manually overridden enrichable field categories (e.g., drink_window, region, varietal, country). Enrichment skips these fields.';

-- 2. Create add_manual_overrides RPC
CREATE OR REPLACE FUNCTION public.add_manual_overrides(
  p_wine_id uuid,
  p_fields  text[]
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
AS $func$
BEGIN
  UPDATE public.wines
  SET manual_overrides = array(
    SELECT DISTINCT unnest(array_cat(manual_overrides, p_fields))
  )
  WHERE id = p_wine_id;
END;
$func$;

COMMENT ON FUNCTION public.add_manual_overrides(uuid, text[]) IS
  'BND-277/BND-278: merge field category overrides. Idempotent.';


CREATE OR REPLACE FUNCTION public.enrich_wines_batch(
  p_restaurant_id uuid,
  p_enrichments   jsonb
) RETURNS int
LANGUAGE plpgsql
SECURITY INVOKER
AS $func$
DECLARE
  v_count int;
BEGIN
  IF p_enrichments IS NULL OR jsonb_typeof(p_enrichments) <> 'array' OR jsonb_array_length(p_enrichments) = 0 THEN
    RETURN 0;
  END IF;

  WITH u AS (
    SELECT
      (e->>'id')::uuid                  AS id,
      (e->>'drink_window_start')::int    AS drink_window_start,
      (e->>'drink_window_end')::int      AS drink_window_end,
      (e->>'peak_year')::int             AS peak_year,
      (e->>'rating')::numeric            AS rating,
      (e->>'rating_source')              AS rating_source,
      (e->>'review_excerpt')             AS review_excerpt,
      (e->>'serving_temp_min')::int      AS serving_temp_min,
      (e->>'serving_temp_max')::int      AS serving_temp_max,
      (e->>'serving_temp_label')         AS serving_temp_label,
      (e->>'decant_minutes')::int        AS decant_minutes,
      (e->>'region')                     AS region,
      (e->>'country')                    AS country,
      (e->>'varietal')                   AS varietal,
      (e->>'enrichment_metadata')::jsonb AS enrichment_metadata
    FROM jsonb_array_elements(p_enrichments) AS e
  )
  UPDATE public.wines w
  SET
    drink_window_start = CASE
      WHEN 'drink_window' = ANY(w.manual_overrides) THEN w.drink_window_start
      ELSE coalesce(u.drink_window_start, w.drink_window_start)
    END,
    drink_window_end   = CASE
      WHEN 'drink_window' = ANY(w.manual_overrides) THEN w.drink_window_end
      ELSE coalesce(u.drink_window_end, w.drink_window_end)
    END,
    peak_year          = CASE
      WHEN 'drink_window' = ANY(w.manual_overrides) THEN w.peak_year
      ELSE coalesce(u.peak_year, w.peak_year)
    END,
    region             = CASE
      WHEN 'region' = ANY(w.manual_overrides) THEN w.region
      ELSE coalesce(u.region, w.region)
    END,
    country            = CASE
      WHEN 'country' = ANY(w.manual_overrides) THEN w.country
      ELSE coalesce(u.country, w.country)
    END,
    varietal           = CASE
      WHEN 'varietal' = ANY(w.manual_overrides) THEN w.varietal
      ELSE coalesce(u.varietal, w.varietal)
    END,
    rating             = coalesce(u.rating,             w.rating),
    rating_source      = coalesce(u.rating_source,      w.rating_source),
    review_excerpt     = coalesce(u.review_excerpt,     w.review_excerpt),
    serving_temp_min   = coalesce(u.serving_temp_min,   w.serving_temp_min),
    serving_temp_max   = coalesce(u.serving_temp_max,   w.serving_temp_max),
    serving_temp_label = coalesce(u.serving_temp_label, w.serving_temp_label),
    decant_minutes     = coalesce(u.decant_minutes,     w.decant_minutes),
    enrichment_metadata = coalesce(u.enrichment_metadata, w.enrichment_metadata),
    last_enriched_at   = now()
  FROM u
  WHERE w.id = u.id
    AND w.restaurant_id = p_restaurant_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$func$;

COMMENT ON FUNCTION public.enrich_wines_batch(uuid, jsonb) IS
  'BND-031/BND-039/BND-070/BND-277/BND-278: atomic batch enrichment with manual-override gating.';

-- === 0049_inventory_items_format_currency.sql ===
-- 0049_inventory_items_format_currency.sql
-- Add format and currency columns to inventory_items for invoice scan data fidelity.

alter table public.inventory_items
  add column if not exists format   text,
  add column if not exists currency text;

-- === 0049_wines_colour.sql ===
-- 0049_wines_colour.sql
-- BND-277: Add colour column to wines and update enrich_wines_batch
-- to extract and persist colour from LWIN catalog fallback enrichments.

-- 1. Add colour column
ALTER TABLE public.wines ADD COLUMN colour text;

-- 2. Add manual_overrides column

COMMENT ON COLUMN public.wines.colour IS 'BND-277 -- wine colour populated via LWIN catalog fallback.';

-- 3. Add manual_overrides column
ALTER TABLE public.wines
  ADD COLUMN manual_overrides text[] DEFAULT '{}';

COMMENT ON COLUMN public.wines.manual_overrides IS
  'BND-277/BND-278 -- manually overridden enrichable field categories (e.g., drink_window, region, varietal, country). Enrichment skips these fields.';

-- 4. Create add_manual_overrides RPC
CREATE OR REPLACE FUNCTION public.add_manual_overrides(
  p_wine_id uuid,
  p_fields  text[]
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
AS $func$
BEGIN
  UPDATE public.wines
  SET manual_overrides = array(
    SELECT DISTINCT unnest(array_cat(manual_overrides, p_fields))
  )
  WHERE id = p_wine_id;
END;
$func$;

COMMENT ON FUNCTION public.add_manual_overrides(uuid, text[]) IS
  'BND-277/BND-278: merge field category overrides. Idempotent.';


CREATE OR REPLACE FUNCTION public.enrich_wines_batch(
  p_restaurant_id uuid,
  p_enrichments   jsonb
) RETURNS int
LANGUAGE plpgsql
SECURITY INVOKER
AS $func$
DECLARE
  v_count int;
BEGIN
  IF p_enrichments IS NULL OR jsonb_typeof(p_enrichments) <> 'array' OR jsonb_array_length(p_enrichments) = 0 THEN
    RETURN 0;
  END IF;

  WITH u AS (
    SELECT
      (e->>'id')::uuid                  AS id,
      (e->>'drink_window_start')::int    AS drink_window_start,
      (e->>'drink_window_end')::int      AS drink_window_end,
      (e->>'peak_year')::int             AS peak_year,
      (e->>'rating')::numeric            AS rating,
      (e->>'rating_source')              AS rating_source,
      (e->>'review_excerpt')             AS review_excerpt,
      (e->>'serving_temp_min')::int      AS serving_temp_min,
      (e->>'serving_temp_max')::int      AS serving_temp_max,
      (e->>'serving_temp_label')         AS serving_temp_label,
      (e->>'decant_minutes')::int        AS decant_minutes,
      (e->>'region')                     AS region,
      (e->>'country')                    AS country,
      (e->>'varietal')                   AS varietal,
      (e->>'colour')                     AS colour,
      (e->>'enrichment_metadata')::jsonb AS enrichment_metadata
    FROM jsonb_array_elements(p_enrichments) AS e
  )
  UPDATE public.wines w
  SET
    drink_window_start = CASE
      WHEN 'drink_window' = ANY(w.manual_overrides) THEN w.drink_window_start
      ELSE coalesce(u.drink_window_start, w.drink_window_start)
    END,
    drink_window_end   = CASE
      WHEN 'drink_window' = ANY(w.manual_overrides) THEN w.drink_window_end
      ELSE coalesce(u.drink_window_end, w.drink_window_end)
    END,
    peak_year          = CASE
      WHEN 'drink_window' = ANY(w.manual_overrides) THEN w.peak_year
      ELSE coalesce(u.peak_year, w.peak_year)
    END,
    region             = CASE
      WHEN 'region' = ANY(w.manual_overrides) THEN w.region
      ELSE coalesce(u.region, w.region)
    END,
    country            = CASE
      WHEN 'country' = ANY(w.manual_overrides) THEN w.country
      ELSE coalesce(u.country, w.country)
    END,
    varietal           = CASE
      WHEN 'varietal' = ANY(w.manual_overrides) THEN w.varietal
      ELSE coalesce(u.varietal, w.varietal)
    END,
    colour             = CASE
      WHEN 'colour' = ANY(w.manual_overrides) THEN w.colour
      ELSE coalesce(u.colour, w.colour)
    END,
    rating             = coalesce(u.rating,             w.rating),
    rating_source      = coalesce(u.rating_source,      w.rating_source),
    review_excerpt     = coalesce(u.review_excerpt,     w.review_excerpt),
    serving_temp_min   = coalesce(u.serving_temp_min,   w.serving_temp_min),
    serving_temp_max   = coalesce(u.serving_temp_max,   w.serving_temp_max),
    serving_temp_label = coalesce(u.serving_temp_label, w.serving_temp_label),
    decant_minutes     = coalesce(u.decant_minutes,     w.decant_minutes),
    enrichment_metadata = coalesce(u.enrichment_metadata, w.enrichment_metadata),
    last_enriched_at   = now()
  FROM u
  WHERE w.id = u.id
    AND w.restaurant_id = p_restaurant_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$func$;

COMMENT ON FUNCTION public.enrich_wines_batch(uuid, jsonb) IS
  'BND-031/BND-039/BND-070/BND-277/BND-278: atomic batch enrichment with colour support and manual-override gating.';

-- === 0050_pour_events_delete_trigger.sql ===
-- 0050_pour_events_delete_trigger.sql -- BND-118
-- Adds an AFTER DELETE trigger on pour_events that reverses the
-- effect of the insert trigger, maintaining open_bottles.remaining_ml
-- consistency when pour_events rows are removed.
--
-- The insert trigger (pour_events_maintain_open_bottle) updates
-- open_bottles on INSERT. This delete trigger reverses those
-- state changes on DELETE.

-- 1. Create the delete trigger function

create or replace function public.pour_events_reverse_open_bottle()
returns trigger
language plpgsql
as $$
begin
  if OLD.kind = 'new_bottle' then
    -- new_bottle insert created or reset an open_bottles row.
    -- On delete, close the bottle since the opening event is removed.
    update public.open_bottles
      set remaining_ml = 0,
          closed_at = now()
      where wine_id = OLD.wine_id
        and restaurant_id = OLD.restaurant_id
        and closed_at is null;

  elsif OLD.kind in ('pour','spill','finish_bottle') then
    -- pour/spill/finish_bottle subtracted ml_delta from remaining_ml.
    -- On delete, add it back. Also clear closed_at if the bottle
    -- was drained by this event.
    update public.open_bottles
      set remaining_ml = remaining_ml + OLD.ml_delta,
          closed_at = null
      where wine_id = OLD.wine_id
        and restaurant_id = OLD.restaurant_id;

  elsif OLD.kind = 'reconcile' then
    -- reconcile subtracts (remaining - new_remaining) = delta from open.
    -- Reverse: add the delta back.
    update public.open_bottles
      set remaining_ml = remaining_ml + OLD.ml_delta,
          closed_at = null
      where wine_id = OLD.wine_id
        and restaurant_id = OLD.restaurant_id;
  end if;
  return OLD;
end;
$$;

-- 2. Attach the AFTER DELETE trigger

create trigger pour_events_delete_trigger
  after delete on public.pour_events
  for each row execute function public.pour_events_reverse_open_bottle();

-- === 0051_wines_overpaid_flag.sql ===
-- 0051_wines_overpaid_flag.sql
-- BND-139: overpaid_flag column for flagging wines for follow-up on /price-comparison
alter table public.wines add column overpaid_flag boolean not null default false;

-- === 0052_background_jobs.sql ===
-- 0052_background_jobs.sql
-- Retryable job records for long-running OCR, enrichment, and PDF work.
-- This migration adds the durable state model only; worker activation and
-- moving request paths async remain operational follow-up work.

create table public.background_jobs (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references public.restaurants(id) on delete cascade,
  created_by     uuid references auth.users(id) on delete set null,
  job_type       text not null check (
    job_type in ('invoice_ocr', 'wine_enrichment', 'wine_list_pdf')
  ),
  status         text not null default 'queued' check (
    status in ('queued', 'processing', 'retrying', 'succeeded', 'failed', 'cancelled')
  ),
  subject_table  text,
  subject_id     uuid,
  attempt_count  integer not null default 0 check (attempt_count >= 0),
  max_attempts   integer not null default 3 check (max_attempts > 0),
  run_after      timestamptz not null default now(),
  started_at     timestamptz,
  finished_at    timestamptz,
  error_code     text,
  error_message  text,
  result         jsonb not null default '{}'::jsonb,
  metadata       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint background_jobs_attempt_window
    check (attempt_count <= max_attempts)
);

create trigger background_jobs_set_updated_at
  before update on public.background_jobs
  for each row execute function public.set_updated_at();

create index background_jobs_restaurant_status_idx
  on public.background_jobs (restaurant_id, status, run_after);

create index background_jobs_subject_idx
  on public.background_jobs (job_type, subject_table, subject_id);

alter table public.background_jobs enable row level security;

create policy "members can read background jobs"
  on public.background_jobs for select
  to authenticated
  using (public.is_member(restaurant_id));

create policy "members can create own background jobs"
  on public.background_jobs for insert
  to authenticated
  with check (
    public.is_member_with_role(restaurant_id, 'staff')
    and created_by = auth.uid()
  );

comment on table public.background_jobs is
  'Durable retryable job state for long-running OCR, enrichment, and PDF work.';

comment on column public.background_jobs.status is
  'queued, processing, retrying, succeeded, failed, or cancelled.';

comment on column public.background_jobs.job_type is
  'invoice_ocr, wine_enrichment, or wine_list_pdf.';

-- === 0053_reason_codes.sql ===
-- 0053_reason_codes.sql
-- F-1 (top-10 wave 0, docs/evals/top10-evals.yaml EV-F1.1): structured reason
-- codes for comps, spills, spoilage, and manual adjustments. Pre-seeded per
-- restaurant so downstream accountability analytics (OPP-7) and spoilage
-- write-offs (OPP-10) never start from an empty table — the Bevrly lesson
-- (audit doc 17 §1.13: zero codes configured at a live customer, so nothing
-- downstream could ever carry a structured cause).

create table public.reason_codes (
  id             uuid        primary key default gen_random_uuid(),
  restaurant_id  uuid        not null references public.restaurants(id) on delete cascade,
  code           text        not null,
  label          text        not null,
  category       text        not null check (
    category in ('comp', 'spill', 'training', 'spoilage', 'adjustment', 'other')
  ),
  active         boolean     not null default true,
  created_at     timestamptz not null default now()
);

create unique index reason_codes_restaurant_code_idx
  on public.reason_codes (restaurant_id, code);

create index reason_codes_restaurant_id_idx
  on public.reason_codes (restaurant_id);

alter table public.reason_codes enable row level security;

create policy "members can read reason_codes"
  on public.reason_codes for select
  using (public.is_member(restaurant_id));

create policy "managers can insert reason_codes"
  on public.reason_codes for insert
  with check (public.is_member_with_role(restaurant_id, 'manager'));

create policy "managers can update reason_codes"
  on public.reason_codes for update
  using      (public.is_member_with_role(restaurant_id, 'manager'))
  with check (public.is_member_with_role(restaurant_id, 'manager'));

-- No delete policy: codes are deactivated (active = false), never deleted,
-- so historical events always keep their referent.

create or replace function public.seed_reason_codes(p_restaurant_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.reason_codes (restaurant_id, code, label, category)
  values
    (p_restaurant_id, 'comp_guest',    'Comped — guest recovery',      'comp'),
    (p_restaurant_id, 'comp_industry', 'Comped — industry / VIP',      'comp'),
    (p_restaurant_id, 'spill',         'Spilled / broken',             'spill'),
    (p_restaurant_id, 'training',      'Staff training / tasting',     'training'),
    (p_restaurant_id, 'spoilage',      'Corked / oxidised / spoiled',  'spoilage'),
    (p_restaurant_id, 'count_adjust',  'Count correction',             'adjustment'),
    (p_restaurant_id, 'other',         'Other',                        'other')
  on conflict (restaurant_id, code) do nothing;
$$;

-- Signup trigger now also seeds reason codes. Body otherwise identical to
-- 0001_auth_boundary.sql's definition.
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

  perform public.seed_reason_codes(new_restaurant_id);

  return new;
end;
$$;

-- Backfill: seed reason codes for existing restaurants
select public.seed_reason_codes(r.id) from public.restaurants r;

-- === 0054_wine_lineages.sql ===
-- 0054_wine_lineages.sql
-- F-2 + OPP-1 (top-10 wave 0, docs/evals/top10-evals.yaml EV-F2.1, EV-1.1–1.4):
-- vintage as first-class identity. A lineage is one producer-cuvée; vintages
-- are distinct child wines carrying their own cost basis. Identity comes from
-- LWIN7 (wines.lwin_id prefix — lwin_catalog is wine-level, no vintage) with a
-- normalised producer+name fallback; wines whose name-group matches more than
-- one LWIN identity stay unlinked (ambiguous) for review.
--
-- Derivation is a BEFORE trigger so every creation path — cellar add, scan
-- commit, create-from-lwin — gets a lineage with no app-side coordination.
-- Cross-vintage merging is rejected here in merge_wines, not just hidden in
-- the UI: for wine, vintage is identity, not duplication.

create table public.wine_lineages (
  id             uuid        primary key default gen_random_uuid(),
  restaurant_id  uuid        not null references public.restaurants(id) on delete cascade,
  lwin7          text        check (lwin7 ~ '^[0-9]{7}$'),
  producer_norm  text        not null,
  cuvee_norm     text        not null,
  created_at     timestamptz not null default now()
);

create unique index wine_lineages_lwin7_idx
  on public.wine_lineages (restaurant_id, lwin7)
  where lwin7 is not null;

create unique index wine_lineages_name_idx
  on public.wine_lineages (restaurant_id, producer_norm, cuvee_norm)
  where lwin7 is null;

create index wine_lineages_norms_idx
  on public.wine_lineages (restaurant_id, producer_norm, cuvee_norm);

alter table public.wine_lineages enable row level security;

create policy "members can read wine_lineages"
  on public.wine_lineages for select
  using (public.is_member(restaurant_id));

-- No client write policies: lineages are created/assigned only by the
-- security-definer derivation trigger below.

alter table public.wines
  add column lineage_id uuid references public.wine_lineages(id) on delete set null;

create index wines_lineage_id_idx on public.wines (lineage_id);

create or replace function public.derive_wine_lineage()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lwin7         text;
  v_producer_norm text;
  v_cuvee_norm    text;
  v_lineage_id    uuid;
  v_match_count   int;
begin
  v_producer_norm := lower(btrim(new.producer));
  v_cuvee_norm    := lower(btrim(new.name));
  v_lwin7 := case
    when new.lwin_id is not null and new.lwin_id ~ '^[0-9]{7}'
      then substr(new.lwin_id, 1, 7)
    else null
  end;

  if v_lwin7 is not null then
    -- LWIN identity wins.
    insert into public.wine_lineages (restaurant_id, lwin7, producer_norm, cuvee_norm)
    values (new.restaurant_id, v_lwin7, v_producer_norm, v_cuvee_norm)
    on conflict (restaurant_id, lwin7) where lwin7 is not null do nothing
    returning id into v_lineage_id;
    if v_lineage_id is null then
      select id into v_lineage_id
        from public.wine_lineages
       where restaurant_id = new.restaurant_id and lwin7 = v_lwin7;
    end if;
  else
    -- Name fallback: adopt the LWIN lineage with these norms iff exactly one.
    select count(*), min(id::text)::uuid
      into v_match_count, v_lineage_id
      from public.wine_lineages
     where restaurant_id = new.restaurant_id
       and lwin7 is not null
       and producer_norm = v_producer_norm
       and cuvee_norm = v_cuvee_norm;

    if v_match_count > 1 then
      -- Ambiguous identity: leave unlinked for review (EV-F2.1).
      v_lineage_id := null;
    elsif v_match_count = 0 then
      insert into public.wine_lineages (restaurant_id, producer_norm, cuvee_norm)
      values (new.restaurant_id, v_producer_norm, v_cuvee_norm)
      on conflict (restaurant_id, producer_norm, cuvee_norm) where lwin7 is null do nothing
      returning id into v_lineage_id;
      if v_lineage_id is null then
        select id into v_lineage_id
          from public.wine_lineages
         where restaurant_id = new.restaurant_id
           and lwin7 is null
           and producer_norm = v_producer_norm
           and cuvee_norm = v_cuvee_norm;
      end if;
    end if;
  end if;

  new.lineage_id := v_lineage_id;
  return new;
end;
$$;

create trigger wines_derive_lineage
  before insert or update of lwin_id, producer, name
  on public.wines
  for each row execute function public.derive_wine_lineage();

-------------------------------------------------------------------------------
-- Backfill existing wines. Pass A: LWIN-identified wines. Pass B: name-keyed
-- wines, adopting a unique LWIN lineage where one exists, staying null where
-- the name-group is ambiguous (matches 2+ LWIN identities).
-- Updates below only touch lineage_id, so the derivation trigger (scoped to
-- lwin_id/producer/name) does not fire.
-------------------------------------------------------------------------------

insert into public.wine_lineages (restaurant_id, lwin7, producer_norm, cuvee_norm)
select distinct on (w.restaurant_id, substr(w.lwin_id, 1, 7))
       w.restaurant_id,
       substr(w.lwin_id, 1, 7),
       lower(btrim(w.producer)),
       lower(btrim(w.name))
  from public.wines w
 where w.lwin_id ~ '^[0-9]{7}'
 order by w.restaurant_id, substr(w.lwin_id, 1, 7), w.created_at
on conflict (restaurant_id, lwin7) where lwin7 is not null do nothing;

update public.wines w
   set lineage_id = l.id
  from public.wine_lineages l
 where w.lwin_id ~ '^[0-9]{7}'
   and l.restaurant_id = w.restaurant_id
   and l.lwin7 = substr(w.lwin_id, 1, 7);

update public.wines w
   set lineage_id = m.lineage_id
  from (
        select l.restaurant_id, l.producer_norm, l.cuvee_norm,
               min(l.id::text)::uuid as lineage_id
          from public.wine_lineages l
         where l.lwin7 is not null
         group by 1, 2, 3
        having count(*) = 1
       ) m
 where w.lineage_id is null
   and (w.lwin_id is null or w.lwin_id !~ '^[0-9]{7}')
   and w.restaurant_id = m.restaurant_id
   and lower(btrim(w.producer)) = m.producer_norm
   and lower(btrim(w.name)) = m.cuvee_norm;

insert into public.wine_lineages (restaurant_id, producer_norm, cuvee_norm)
select distinct w.restaurant_id, lower(btrim(w.producer)), lower(btrim(w.name))
  from public.wines w
 where w.lineage_id is null
   and (w.lwin_id is null or w.lwin_id !~ '^[0-9]{7}')
   and not exists (
         select 1
           from public.wine_lineages l
          where l.restaurant_id = w.restaurant_id
            and l.lwin7 is not null
            and l.producer_norm = lower(btrim(w.producer))
            and l.cuvee_norm = lower(btrim(w.name))
       )
on conflict (restaurant_id, producer_norm, cuvee_norm) where lwin7 is null do nothing;

update public.wines w
   set lineage_id = l.id
  from public.wine_lineages l
 where w.lineage_id is null
   and (w.lwin_id is null or w.lwin_id !~ '^[0-9]{7}')
   and l.restaurant_id = w.restaurant_id
   and l.lwin7 is null
   and l.producer_norm = lower(btrim(w.producer))
   and l.cuvee_norm = lower(btrim(w.name));

-------------------------------------------------------------------------------
-- merge_wines — the only sanctioned duplicate-collapse path (EV-1.2, EV-1.3).
-- Role-checked security-definer RPC, same pattern as record_pour /
-- reconcile_open_bottles_batch. Guards are enforced HERE: same lineage, same
-- vintage, same format. Repoints every wines referrer, then deletes source.
-------------------------------------------------------------------------------

create or replace function public.merge_wines(
  p_source_wine_id uuid,
  p_target_wine_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source            public.wines%rowtype;
  v_target            public.wines%rowtype;
  v_restaurant_id     uuid;
  v_moved_inventory   int;
  v_moved_pours       int;
  v_moved_bottles     int;
  v_moved_list_items  int;
  v_moved_avail       int;
begin
  if p_source_wine_id = p_target_wine_id then
    raise exception 'identical_merge: source and target are the same wine';
  end if;

  -- Deterministic lock order to avoid deadlocks between concurrent merges.
  perform 1 from public.wines
    where id in (p_source_wine_id, p_target_wine_id)
    order by id
    for update;

  select * into v_source from public.wines where id = p_source_wine_id;
  select * into v_target from public.wines where id = p_target_wine_id;

  if v_source.id is null or v_target.id is null
     or v_source.restaurant_id <> v_target.restaurant_id then
    raise exception 'wine_not_found: both wines must exist in the same restaurant';
  end if;

  v_restaurant_id := v_source.restaurant_id;
  if not public.is_member_with_role(v_restaurant_id, 'manager') then
    raise exception 'forbidden: manager role required to merge wines';
  end if;

  if v_source.lineage_id is null or v_target.lineage_id is null
     or v_source.lineage_id <> v_target.lineage_id then
    raise exception 'lineage_mismatch_merge: wines are not the same producer-cuvée — merging is only for true duplicates';
  end if;

  if coalesce(v_source.vintage, 0) <> coalesce(v_target.vintage, 0) then
    raise exception 'cross_vintage_merge: % and % are distinct vintages — they are already linked as vintage siblings, not duplicates',
      coalesce(v_source.vintage::text, 'NV'), coalesce(v_target.vintage::text, 'NV');
  end if;

  if v_source.size_ml <> v_target.size_ml then
    raise exception 'format_mismatch_merge: % ml and % ml are distinct formats',
      v_source.size_ml, v_target.size_ml;
  end if;

  -- Repoint every referrer; history rows keep their own timestamps, actors,
  -- and costs — the audit trail survives the merge (EV-1.2).
  update public.inventory_items set wine_id = p_target_wine_id
   where wine_id = p_source_wine_id;
  get diagnostics v_moved_inventory = row_count;

  update public.pour_events set wine_id = p_target_wine_id
   where wine_id = p_source_wine_id;
  get diagnostics v_moved_pours = row_count;

  update public.open_bottles set wine_id = p_target_wine_id
   where wine_id = p_source_wine_id;
  get diagnostics v_moved_bottles = row_count;

  update public.wine_list_items set wine_id = p_target_wine_id
   where wine_id = p_source_wine_id;
  get diagnostics v_moved_list_items = row_count;

  update public.availability_events set wine_id = p_target_wine_id
   where wine_id = p_source_wine_id;
  get diagnostics v_moved_avail = row_count;

  delete from public.wines where id = p_source_wine_id;

  return jsonb_build_object(
    'target_id',                p_target_wine_id,
    'moved_inventory_items',    v_moved_inventory,
    'moved_pour_events',        v_moved_pours,
    'moved_open_bottles',       v_moved_bottles,
    'moved_wine_list_items',    v_moved_list_items,
    'moved_availability_events', v_moved_avail
  );
end;
$$;

-- === 0055_lineage_verify_fixes.sql ===
-- 0055_lineage_verify_fixes.sql
-- Wave-0 adversarial-review fixes (Grok 4.6 verify pass, findings V1/V2/V6 —
-- see Terroir Planning/evidence/model-audits/wave0-verify-grok.json):
--
--  V1 (high)  derive_wine_lineage forked vintage siblings when a wine on a
--             name-keyed lineage later gained an lwin_id: the LWIN branch
--             always created a NEW lineage and moved only that wine. Fix:
--             upgrade a matching name-keyed lineage in place (set lwin7) so
--             every sibling keeps the same lineage_id.
--  V2 (med)   merge_wines could leave the target listed twice in one wine
--             list section (no uniqueness on (section_id, wine_id)). Fix:
--             drop source list rows whose section already lists the target,
--             then repoint the rest; report the dedupe count.
--  V6 (low)   seed_reason_codes was executable by any authenticated session
--             against any restaurant id (security definer, no authz). Fix:
--             revoke direct execute; the signup trigger and migrations run
--             as owner and are unaffected.

-- V6 — seed_reason_codes is infrastructure, not an API.
revoke execute on function public.seed_reason_codes(uuid)
  from public, anon, authenticated;

-- V1 — replace the derivation trigger function.
create or replace function public.derive_wine_lineage()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lwin7         text;
  v_producer_norm text;
  v_cuvee_norm    text;
  v_lineage_id    uuid;
  v_match_count   int;
begin
  v_producer_norm := lower(btrim(new.producer));
  v_cuvee_norm    := lower(btrim(new.name));
  v_lwin7 := case
    when new.lwin_id is not null and new.lwin_id ~ '^[0-9]{7}'
      then substr(new.lwin_id, 1, 7)
    else null
  end;

  if v_lwin7 is not null then
    -- LWIN identity wins. Adoption order:
    --   1. an existing LWIN lineage for this code;
    --   2. upgrade a matching name-keyed lineage in place (sets lwin7), so
    --      vintage siblings that predate LWIN enrichment keep their lineage;
    --   3. create a fresh LWIN lineage.
    select id into v_lineage_id
      from public.wine_lineages
     where restaurant_id = new.restaurant_id and lwin7 = v_lwin7;

    if v_lineage_id is null then
      begin
        update public.wine_lineages
           set lwin7 = v_lwin7
         where restaurant_id = new.restaurant_id
           and lwin7 is null
           and producer_norm = v_producer_norm
           and cuvee_norm = v_cuvee_norm
        returning id into v_lineage_id;
      exception when unique_violation then
        -- Concurrent transaction created this LWIN lineage; adopt it below.
        v_lineage_id := null;
      end;
    end if;

    if v_lineage_id is null then
      insert into public.wine_lineages (restaurant_id, lwin7, producer_norm, cuvee_norm)
      values (new.restaurant_id, v_lwin7, v_producer_norm, v_cuvee_norm)
      on conflict (restaurant_id, lwin7) where lwin7 is not null do nothing
      returning id into v_lineage_id;
      if v_lineage_id is null then
        select id into v_lineage_id
          from public.wine_lineages
         where restaurant_id = new.restaurant_id and lwin7 = v_lwin7;
      end if;
    end if;
  else
    -- Name fallback: adopt the LWIN lineage with these norms iff exactly one.
    select count(*), min(id::text)::uuid
      into v_match_count, v_lineage_id
      from public.wine_lineages
     where restaurant_id = new.restaurant_id
       and lwin7 is not null
       and producer_norm = v_producer_norm
       and cuvee_norm = v_cuvee_norm;

    if v_match_count > 1 then
      v_lineage_id := null;
    elsif v_match_count = 0 then
      select id into v_lineage_id
        from public.wine_lineages
       where restaurant_id = new.restaurant_id
         and lwin7 is null
         and producer_norm = v_producer_norm
         and cuvee_norm = v_cuvee_norm;
      if v_lineage_id is null then
        insert into public.wine_lineages (restaurant_id, producer_norm, cuvee_norm)
        values (new.restaurant_id, v_producer_norm, v_cuvee_norm)
        on conflict (restaurant_id, producer_norm, cuvee_norm) where lwin7 is null do nothing
        returning id into v_lineage_id;
        if v_lineage_id is null then
          select id into v_lineage_id
            from public.wine_lineages
           where restaurant_id = new.restaurant_id
             and lwin7 is null
             and producer_norm = v_producer_norm
             and cuvee_norm = v_cuvee_norm;
        end if;
      end if;
    end if;
  end if;

  new.lineage_id := v_lineage_id;
  return new;
end;
$$;

-- V2 — replace merge_wines with section-level list dedupe.
create or replace function public.merge_wines(
  p_source_wine_id uuid,
  p_target_wine_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source            public.wines%rowtype;
  v_target            public.wines%rowtype;
  v_restaurant_id     uuid;
  v_moved_inventory   int;
  v_moved_pours       int;
  v_moved_bottles     int;
  v_moved_list_items  int;
  v_deduped_list_items int;
  v_moved_avail       int;
begin
  if p_source_wine_id = p_target_wine_id then
    raise exception 'identical_merge: source and target are the same wine';
  end if;

  perform 1 from public.wines
    where id in (p_source_wine_id, p_target_wine_id)
    order by id
    for update;

  select * into v_source from public.wines where id = p_source_wine_id;
  select * into v_target from public.wines where id = p_target_wine_id;

  if v_source.id is null or v_target.id is null
     or v_source.restaurant_id <> v_target.restaurant_id then
    raise exception 'wine_not_found: both wines must exist in the same restaurant';
  end if;

  v_restaurant_id := v_source.restaurant_id;
  if not public.is_member_with_role(v_restaurant_id, 'manager') then
    raise exception 'forbidden: manager role required to merge wines';
  end if;

  if v_source.lineage_id is null or v_target.lineage_id is null
     or v_source.lineage_id <> v_target.lineage_id then
    raise exception 'lineage_mismatch_merge: wines are not the same producer-cuvée — merging is only for true duplicates';
  end if;

  if coalesce(v_source.vintage, 0) <> coalesce(v_target.vintage, 0) then
    raise exception 'cross_vintage_merge: % and % are distinct vintages — they are already linked as vintage siblings, not duplicates',
      coalesce(v_source.vintage::text, 'NV'), coalesce(v_target.vintage::text, 'NV');
  end if;

  if v_source.size_ml <> v_target.size_ml then
    raise exception 'format_mismatch_merge: % ml and % ml are distinct formats',
      v_source.size_ml, v_target.size_ml;
  end if;

  update public.inventory_items set wine_id = p_target_wine_id
   where wine_id = p_source_wine_id;
  get diagnostics v_moved_inventory = row_count;

  update public.pour_events set wine_id = p_target_wine_id
   where wine_id = p_source_wine_id;
  get diagnostics v_moved_pours = row_count;

  update public.open_bottles set wine_id = p_target_wine_id
   where wine_id = p_source_wine_id;
  get diagnostics v_moved_bottles = row_count;

  -- A section listing BOTH wines would show the target twice after a blind
  -- repoint (no uniqueness on (section_id, wine_id)). Drop the source's row
  -- wherever the target is already listed, then repoint the rest.
  delete from public.wine_list_items s
   where s.wine_id = p_source_wine_id
     and exists (
           select 1 from public.wine_list_items t
            where t.section_id = s.section_id
              and t.wine_id = p_target_wine_id
         );
  get diagnostics v_deduped_list_items = row_count;

  update public.wine_list_items set wine_id = p_target_wine_id
   where wine_id = p_source_wine_id;
  get diagnostics v_moved_list_items = row_count;

  update public.availability_events set wine_id = p_target_wine_id
   where wine_id = p_source_wine_id;
  get diagnostics v_moved_avail = row_count;

  delete from public.wines where id = p_source_wine_id;

  return jsonb_build_object(
    'target_id',                 p_target_wine_id,
    'moved_inventory_items',     v_moved_inventory,
    'moved_pour_events',         v_moved_pours,
    'moved_open_bottles',        v_moved_bottles,
    'moved_wine_list_items',     v_moved_list_items,
    'deduped_wine_list_items',   v_deduped_list_items,
    'moved_availability_events', v_moved_avail
  );
end;
$$;
