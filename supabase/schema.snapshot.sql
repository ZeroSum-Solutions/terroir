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

-- === 0038_pour_events_open_bottle_id.sql ===
-- 0038_pour_events_open_bottle_id.sql -- BND-117, BND-119
-- The descriptive suffix is required for Supabase to apply this migration.
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

-- === 0049_wines_colour.sql ===
-- 0049_wines_colour.sql
-- BND-277: Add colour column to wines and update enrich_wines_batch
-- to extract and persist colour from LWIN catalog fallback enrichments.

-- 1. Add colour column
ALTER TABLE public.wines ADD COLUMN colour text;

COMMENT ON COLUMN public.wines.colour IS 'BND-277 -- wine colour populated via LWIN catalog fallback.';

-- 2. Extend the 0048 manual-override-aware enrichment RPC with colour.
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

-- === 0056_lineage_hardening.sql ===
-- 0056_lineage_hardening.sql
-- Second verify round (GPT-5.6-sol high — wave0-verify-sol.json), fixes:
--
--  S3 (high) wines.lineage_id was directly writable by tenants without
--            re-derivation (the trigger only watched lwin_id/producer/name),
--            letting a manager hand-link two unrelated wines and pass
--            merge_wines' lineage guard. Fix: the trigger now also fires on
--            UPDATE OF lineage_id and recomputes — a client-supplied value
--            is always overwritten by derivation, so lineage_id is
--            effectively derivation-owned. (A future manual link/unlink
--            feature must ship as its own security-definer RPC.)
--  S1        Cross-path derivation race (concurrent first inserts of the
--            same identity, one with LWIN, one without) could create both a
--            name-keyed and an LWIN lineage. Fix: per-identity advisory
--            transaction lock serializes derivation.
--  S4        Renaming a wine never refreshed its LWIN lineage's stored
--            norms, silently breaking future name-fallback adoption. Fix:
--            refresh norms on LWIN lineages when the current spelling
--            differs (name-keyed lineages keep theirs — the norm IS their
--            identity).
--
-- Deliberately NOT addressed here (documented limitations):
--  S2  A later second LWIN identity with identical norms does not revisit
--      earlier no-LWIN adoptions; ambiguity review is OPP-5's queue.
--  S5  wine_list_items still has no (section_id, wine_id) uniqueness; the
--      merge dedupe closes the common case but a concurrent insert can
--      still double-list. Whether that uniqueness is a product invariant
--      is an OPP-8 decision.

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

  -- S1: serialize derivation per (restaurant, identity) so the LWIN and
  -- name-fallback paths cannot race each other into two lineages.
  perform pg_advisory_xact_lock(
    hashtextextended(new.restaurant_id::text || '|' || v_producer_norm || '|' || v_cuvee_norm, 42)
  );

  if v_lwin7 is not null then
    select id into v_lineage_id
      from public.wine_lineages
     where restaurant_id = new.restaurant_id and lwin7 = v_lwin7;

    if v_lineage_id is not null then
      -- S4: keep LWIN lineage norms current with the latest spelling so
      -- name-fallback adoption keeps working after corrections.
      update public.wine_lineages
         set producer_norm = v_producer_norm,
             cuvee_norm    = v_cuvee_norm
       where id = v_lineage_id
         and (producer_norm <> v_producer_norm or cuvee_norm <> v_cuvee_norm);
    end if;

    if v_lineage_id is null then
      begin
        -- upgrade a matching name-keyed lineage in place (sets lwin7)
        update public.wine_lineages
           set lwin7 = v_lwin7
         where restaurant_id = new.restaurant_id
           and lwin7 is null
           and producer_norm = v_producer_norm
           and cuvee_norm = v_cuvee_norm
        returning id into v_lineage_id;
      exception when unique_violation then
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

-- S3: lineage_id joins the watched column list — direct writes re-derive.
drop trigger if exists wines_derive_lineage on public.wines;
create trigger wines_derive_lineage
  before insert or update of lwin_id, producer, name, lineage_id
  on public.wines
  for each row execute function public.derive_wine_lineage();

-- === 0057_bins.sql ===
-- 0057_bins.sql
-- OPP-6 (top-10 wave 1, docs/evals/top10-evals.yaml EV-6.x): bin-first
-- location model. Bins are first-class rows — code, zone, capacity,
-- priority — replacing the free-text inventory_items.bin_location as the
-- physical key (the text column stays during migration; new writes go to
-- bin_id). "Unplaced" is a queue state, never a pseudo-bin (EV-6.4).
-- The Bevrly contrast: their /locations screen renders empty while ten
-- locations are in use, and pseudo-locations mix with physical ones
-- (audit doc 17 §1.14, §1.3).

create table public.bins (
  id             uuid        primary key default gen_random_uuid(),
  restaurant_id  uuid        not null references public.restaurants(id) on delete cascade,
  code           text        not null,
  zone           text,
  capacity       int         check (capacity > 0),
  priority       int         not null default 0,
  sort_order     int         not null default 0,
  retired_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- One code namespace per restaurant, case-insensitive ("r4-s3" is "R4-S3").
create unique index bins_restaurant_code_idx
  on public.bins (restaurant_id, lower(code));

create index bins_restaurant_id_idx on public.bins (restaurant_id);

create trigger bins_set_updated_at
  before update on public.bins
  for each row execute function public.set_updated_at();

alter table public.bins enable row level security;

create policy "members can read bins"
  on public.bins for select
  using (public.is_member(restaurant_id));

create policy "managers can insert bins"
  on public.bins for insert
  with check (public.is_member_with_role(restaurant_id, 'manager'));

create policy "managers can update bins"
  on public.bins for update
  using      (public.is_member_with_role(restaurant_id, 'manager'))
  with check (public.is_member_with_role(restaurant_id, 'manager'));

-- No delete policy: bins are retired (retired_at), never deleted, so stock
-- history keeps its referent.

alter table public.inventory_items
  add column bin_id uuid references public.bins(id) on delete set null;

create index inventory_items_bin_id_idx on public.inventory_items (bin_id);

-- EV-6.5 surface: bin codes may flow onto the public list, per list.
alter table public.wine_lists
  add column show_bin_codes boolean not null default false;

-- Backfill: promote every distinct legacy free-text bin_location to a real
-- bin and point the stock at it.
insert into public.bins (restaurant_id, code)
select distinct i.restaurant_id, upper(btrim(i.bin_location))
  from public.inventory_items i
 where i.bin_location is not null
   and btrim(i.bin_location) <> ''
on conflict do nothing;

update public.inventory_items i
   set bin_id = b.id
  from public.bins b
 where i.bin_location is not null
   and btrim(i.bin_location) <> ''
   and b.restaurant_id = i.restaurant_id
   and lower(b.code) = lower(btrim(i.bin_location));

-- === 0058_cellar_health.sql ===
-- 0058_cellar_health.sql
-- OPP-2 (top-10 wave 2, docs/evals/top10-evals.yaml EV-2.x): wine-aware
-- cellar health. Replaces the single "sleepy inventory" bucket (the Bevrly
-- failure: 96% of cellar value flagged, doc 17 §1.2) with a partition —
-- every stocked wine lands in exactly one of window_risk | hold |
-- dead_stock | cash_trap | healthy, each row carrying the human-readable
-- reason for the rule that fired (EV-2.1, EV-2.3). Segments are written by
-- the nightly cellar_health background job; thresholds are owner-tunable
-- on cellar_config so a rerun reclassifies (EV-2.4).

-- 1. Thresholds ----------------------------------------------------------
alter table public.cellar_config
  add column health_dead_stock_days        integer not null default 120
    check (health_dead_stock_days > 0),
  add column health_cash_trap_floor        numeric not null default 500
    check (health_cash_trap_floor >= 0),
  add column health_appreciation_threshold numeric not null default 0.08
    check (health_appreciation_threshold >= 0);

-- 2. Segment storage -----------------------------------------------------
create table public.cellar_health (
  id             uuid        primary key default gen_random_uuid(),
  restaurant_id  uuid        not null references public.restaurants(id) on delete cascade,
  wine_id        uuid        not null references public.wines(id) on delete cascade,
  segment        text        not null check (
    segment in ('window_risk', 'hold', 'dead_stock', 'cash_trap', 'healthy')
  ),
  reason         text        not null,
  computed_at    timestamptz not null default now(),
  unique (restaurant_id, wine_id)
);

create index cellar_health_restaurant_segment_idx
  on public.cellar_health (restaurant_id, segment);

alter table public.cellar_health enable row level security;

create policy "members can read cellar_health"
  on public.cellar_health for select
  using (public.is_member(restaurant_id));

-- Segments are job-computed state: only the service role writes them.
revoke insert, update, delete on public.cellar_health from authenticated, anon;

-- 3. Nightly job type ----------------------------------------------------
alter table public.background_jobs
  drop constraint background_jobs_job_type_check;
alter table public.background_jobs
  add constraint background_jobs_job_type_check check (
    job_type in ('invoice_ocr', 'wine_enrichment', 'wine_list_pdf', 'cellar_health')
  );

-- === 0059_reconcile_queue.sql ===
-- 0059_reconcile_queue.sql
-- OPP-5 (top-10 wave 2, docs/evals/top10-evals.yaml EV-5.x): wine-aware
-- reconciliation queue substrate. The queue rows themselves are DERIVED
-- (unplaced stock, unmatched scan lines, duplicate suspects, ambiguous
-- lineages) — what the schema owns is the accept/undo ledger: bulk-accept
-- groups actions into a batch, every action snapshots the full prior and
-- new state of its subject row, and undo restores prior_state byte-equal
-- within the undo window (EV-5.4). Ranked by capital at risk, not recency
-- (EV-5.2) — that is query-side.

create table public.reconcile_batches (
  id             uuid        primary key default gen_random_uuid(),
  restaurant_id  uuid        not null references public.restaurants(id) on delete cascade,
  created_by     uuid        references auth.users(id) on delete set null,
  action_count   integer     not null default 0 check (action_count >= 0),
  created_at     timestamptz not null default now(),
  undone_at      timestamptz,
  undone_by      uuid        references auth.users(id) on delete set null
);

create index reconcile_batches_restaurant_idx
  on public.reconcile_batches (restaurant_id, created_at desc);

create table public.reconcile_actions (
  id             uuid        primary key default gen_random_uuid(),
  batch_id       uuid        not null references public.reconcile_batches(id) on delete cascade,
  restaurant_id  uuid        not null references public.restaurants(id) on delete cascade,
  action_type    text        not null check (
    action_type in ('place_bin', 'match_scan', 'link_lineage', 'dismiss')
  ),
  subject_table  text        not null,
  subject_id     uuid        not null,
  prior_state    jsonb       not null,
  new_state      jsonb       not null,
  created_at     timestamptz not null default now()
);

create index reconcile_actions_batch_idx
  on public.reconcile_actions (batch_id);
create index reconcile_actions_restaurant_idx
  on public.reconcile_actions (restaurant_id, created_at desc);

alter table public.reconcile_batches enable row level security;
alter table public.reconcile_actions enable row level security;

create policy "members can read reconcile_batches"
  on public.reconcile_batches for select
  using (public.is_member(restaurant_id));

create policy "members can read reconcile_actions"
  on public.reconcile_actions for select
  using (public.is_member(restaurant_id));

create policy "managers can insert reconcile_batches"
  on public.reconcile_batches for insert
  with check (public.is_member_with_role(restaurant_id, 'manager'));

create policy "managers can update reconcile_batches"
  on public.reconcile_batches for update
  using      (public.is_member_with_role(restaurant_id, 'manager'))
  with check (public.is_member_with_role(restaurant_id, 'manager'));

create policy "managers can insert reconcile_actions"
  on public.reconcile_actions for insert
  with check (public.is_member_with_role(restaurant_id, 'manager'));

-- Actions are immutable once written (the audit trail undo relies on);
-- batches close via undone_at, never by rewriting actions.
revoke update, delete on public.reconcile_actions from authenticated;
revoke delete on public.reconcile_batches from authenticated;

-- === 0060_partial_bottles.sql ===
-- 0060_partial_bottles.sql
-- OPP-10 (top-10 wave 2, docs/evals/top10-evals.yaml EV-10.x): partial-
-- bottle lifecycle close-out. open_bottles + pour_events already exist —
-- this adds the preservation method on the open bottle (EV-10.1) and the
-- close-out record: theoretical remaining (size − Σ pours) vs the actual
-- remaining the closer observed, variance persisted per bottle (EV-10.2),
-- grouped by preservation method for the yield report (EV-10.3). A
-- spoilage write-off REQUIRES a reason code — enforced here, not just in
-- the API (F-1, the Bevrly zero-reason-codes lesson).

alter table public.open_bottles
  add column preservation_method text not null default 'none' check (
    preservation_method in ('coravin', 'argon', 'vacuum', 'none')
  );

create table public.bottle_closeouts (
  id                        uuid        primary key default gen_random_uuid(),
  restaurant_id             uuid        not null references public.restaurants(id) on delete cascade,
  wine_id                   uuid        not null references public.wines(id) on delete cascade,
  open_bottle_id            uuid        references public.open_bottles(id) on delete set null,
  preservation_method       text        not null check (
    preservation_method in ('coravin', 'argon', 'vacuum', 'none')
  ),
  opened_at                 timestamptz,
  closed_by                 uuid        references auth.users(id) on delete set null,
  closed_at                 timestamptz not null default now(),
  -- theoretical may go negative when pours were over-recorded; that IS the
  -- variance signal, so it is not clamped.
  theoretical_remaining_ml  integer     not null,
  actual_remaining_ml       integer     not null check (actual_remaining_ml >= 0),
  variance_ml               integer     generated always as
    (actual_remaining_ml - theoretical_remaining_ml) stored,
  written_off_ml            integer     not null default 0 check (written_off_ml >= 0),
  reason_code_id            uuid        references public.reason_codes(id) on delete restrict,
  constraint bottle_closeouts_writeoff_requires_reason check (
    written_off_ml = 0 or reason_code_id is not null
  )
);

create index bottle_closeouts_restaurant_idx
  on public.bottle_closeouts (restaurant_id, closed_at desc);
create index bottle_closeouts_wine_idx
  on public.bottle_closeouts (wine_id, closed_at desc);

alter table public.bottle_closeouts enable row level security;

create policy "members can read bottle_closeouts"
  on public.bottle_closeouts for select
  using (public.is_member(restaurant_id));

create policy "members can insert bottle_closeouts"
  on public.bottle_closeouts for insert
  with check (public.is_member(restaurant_id));

-- Close-outs are immutable records: no update/delete for authenticated.
revoke update, delete on public.bottle_closeouts from authenticated;

-- === 0061_close_open_bottle.sql ===
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

-- === 0062_reconcile_ordinal.sql ===
-- 0062_reconcile_ordinal.sql
-- OPP-5 verify finding V6: undo must restore actions in exact reverse
-- application order, and created_at is not a total order (equal
-- timestamps permit arbitrary sequencing). Each action now records its
-- 0-based position within its batch; undo orders by ordinal desc.

alter table public.reconcile_actions
  add column ordinal integer not null default 0 check (ordinal >= 0);

create unique index reconcile_actions_batch_ordinal_idx
  on public.reconcile_actions (batch_id, ordinal);

-- === 0063_stock_adjustments.sql ===
-- 0063_stock_adjustments.sql
-- OPP-7 (top-10 wave 3, docs/evals/top10-evals.yaml EV-7.x): comp and
-- adjustment events, member-attributed. The Bevrly contrast: comps exist
-- only as a value-tracker movement class with zero reason codes configured
-- (doc 17 §1.9, §1.13). Every event requires a reason code (F-1) and the
-- acting member is the AUTHENTICATED user — enforced by the insert policy,
-- not just the API — so client-supplied member ids can never be persisted
-- (EV-7.1, EV-7.2).

create table public.stock_adjustments (
  id              uuid        primary key default gen_random_uuid(),
  restaurant_id   uuid        not null references public.restaurants(id) on delete cascade,
  wine_id         uuid        not null references public.wines(id) on delete cascade,
  kind            text        not null check (kind in ('comp', 'adjustment')),
  bottles         integer     not null default 0,
  ml              integer     not null default 0,
  constraint stock_adjustments_nonzero check (bottles <> 0 or ml <> 0),
  reason_code_id  uuid        not null references public.reason_codes(id) on delete restrict,
  acting_user_id  uuid        not null references auth.users(id),
  note            text,
  created_at      timestamptz not null default now()
);

create index stock_adjustments_restaurant_idx
  on public.stock_adjustments (restaurant_id, created_at desc);
create index stock_adjustments_member_idx
  on public.stock_adjustments (restaurant_id, acting_user_id, created_at desc);

alter table public.stock_adjustments enable row level security;

create policy "members can read stock_adjustments"
  on public.stock_adjustments for select
  using (public.is_member(restaurant_id));

-- acting_user_id must be the session user: the database, not the API,
-- guarantees events cannot be attributed to someone else.
create policy "members insert own stock_adjustments"
  on public.stock_adjustments for insert
  with check (
    public.is_member(restaurant_id)
    and acting_user_id = auth.uid()
  );

-- Events are immutable.
revoke update, delete on public.stock_adjustments from authenticated;

-- === 0064_brand_kits.sql ===
-- 0064_brand_kits.sql
-- OPP-8 (top-10 wave 3, docs/evals/top10-evals.yaml EV-8.x): brand kit +
-- stored list themes. The Bevrly contrast: logo upload plus six raw colour
-- inputs, no palette extraction, no template, no AI (doc 17 §1.11).
-- brand_kits holds the extracted palette; the applied theme lives on the
-- wine list so /list/[slug] and /api/pdf render from ONE source (8-FR4).
-- Theme JSON is validated (zod + WCAG AA contrast) server-side before save
-- (8-FR5) — the schema stores, the API guards.

create table public.brand_kits (
  id             uuid        primary key default gen_random_uuid(),
  restaurant_id  uuid        not null references public.restaurants(id) on delete cascade,
  logo_url       text,
  palette        jsonb       not null default '{}'::jsonb,
  proposals      jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (restaurant_id)
);

create trigger brand_kits_set_updated_at
  before update on public.brand_kits
  for each row execute function public.set_updated_at();

alter table public.brand_kits enable row level security;

create policy "members can read brand_kits"
  on public.brand_kits for select
  using (public.is_member(restaurant_id));

create policy "managers can insert brand_kits"
  on public.brand_kits for insert
  with check (public.is_member_with_role(restaurant_id, 'manager'));

create policy "managers can update brand_kits"
  on public.brand_kits for update
  using      (public.is_member_with_role(restaurant_id, 'manager'))
  with check (public.is_member_with_role(restaurant_id, 'manager'));

alter table public.wine_lists
  add column theme jsonb;

-- === 0065_pricing_recommendations.sql ===
-- 0065_pricing_recommendations.sql
-- OPP-9 (top-10 wave 3, docs/evals/top10-evals.yaml EV-9.x): materialized
-- pricing recommendations. The Bevrly contrast: -15% on allocated Burgundy
-- from velocity alone, 18s page load (doc 17 §1.10). Recommendations are
-- job-computed (same service-role pattern as cellar_health) so the view
-- reads a table, not an 18-second pipeline (EV-9.4). Every row carries
-- class + rationale + evidence (EV-9.1); the Meursault rule (EV-9.2) is
-- recommender logic, pinned by eval fixture.

create table public.pricing_recommendations (
  id             uuid        primary key default gen_random_uuid(),
  restaurant_id  uuid        not null references public.restaurants(id) on delete cascade,
  wine_id        uuid        not null references public.wines(id) on delete cascade,
  class          text        not null check (
    class in ('discount_to_move', 'raise_appreciating', 'feature_btg', 'hold')
  ),
  rationale      text        not null,
  evidence       jsonb       not null default '{}'::jsonb,
  timing         text,
  computed_at    timestamptz not null default now(),
  unique (restaurant_id, wine_id)
);

create index pricing_recommendations_restaurant_class_idx
  on public.pricing_recommendations (restaurant_id, class);

alter table public.pricing_recommendations enable row level security;

create policy "members can read pricing_recommendations"
  on public.pricing_recommendations for select
  using (public.is_member(restaurant_id));

-- Job-computed state: only the service role writes.
revoke insert, update, delete on public.pricing_recommendations from authenticated, anon;

-- The recompute job type joins the background job vocabulary.
alter table public.background_jobs
  drop constraint background_jobs_job_type_check;
alter table public.background_jobs
  add constraint background_jobs_job_type_check check (
    job_type in ('invoice_ocr', 'wine_enrichment', 'wine_list_pdf', 'cellar_health', 'pricing_recommendations')
  );

-- === 0066_invoice_scans_update_policy.sql ===
-- 0066_invoice_scans_update_policy.sql
--
-- invoice_scans shipped with SELECT + INSERT policies only, so every
-- user-client UPDATE (scan review edits, OPP-5 reconcile match_scan)
-- silently matched zero rows under RLS. The reconcile ledger reads that
-- zero-row result as a compare-and-swap conflict and returns 409
-- "Subject changed during reconciliation." — caught by the @opp-5 E2E.
--
-- Mirror the wines/inventory_items member-update pattern.

create policy "members can update their scans"
  on public.invoice_scans for update to authenticated
  using (public.is_member(restaurant_id))
  with check (public.is_member(restaurant_id));

-- === 0072_wines_tasting_notes_hero_image.sql ===
-- 0072_wines_tasting_notes_hero_image.sql
-- BND-055 + BND-056 + BND-057: add tasting_notes and hero_image_url
-- to the wines table.

alter table public.wines
  add column if not exists tasting_notes text,
  add column if not exists hero_image_url text;

-- === 0073_inventory_items_format_currency.sql ===
-- 0073_inventory_items_format_currency.sql
-- Add format and currency columns to inventory_items for invoice scan data fidelity.

alter table public.inventory_items
  add column if not exists format   text,
  add column if not exists currency text;

-- === 0074_public_api_grants.sql ===
-- Restore the table privileges required by Supabase's Data API roles.
--
-- The local bootstrap intentionally removes DML from postgres-owned default
-- privileges. Terroir migrations run as postgres, so RLS policies alone are
-- insufficient: the API roles also need table privileges before RLS can
-- evaluate a request.

grant select, insert, update, delete
  on all tables in schema public
  to authenticated, service_role;

-- Anonymous clients only need the published-menu read graph. The existing
-- SELECT policies continue to hide drafts and tenant-private rows.
grant select
  on table
    public.restaurants,
    public.wine_lists,
    public.wine_list_sections,
    public.wine_list_items,
    public.wines
  to anon;

-- service_role is the trusted server-side maintenance role. Preserve its DML
-- access for future postgres-owned public tables without widening defaults for
-- anon or authenticated.
alter default privileges for role postgres in schema public
  grant select, insert, update, delete on tables to service_role;

-- === 0075_invoice_extract_jobs.sql ===
-- 0075_invoice_extract_jobs.sql
--
-- G1-6: background job runner, one job type (invoice_extract).
--
-- Reuses the existing public.background_jobs table (0052) instead of
-- creating a parallel jobs table. That table already had restaurant_id,
-- attempt_count/max_attempts, and run_after — this migration adds exactly
-- what invoice_extract's runner needs on top:
--
--   1. `invoice_extract` joins the job_type vocabulary (same pattern as
--      0058/0065 extending this constraint for their own job types).
--   2. `dead` joins the status vocabulary as the terminal failure state,
--      distinct from `failed` (which existing job types may still use as
--      their own terminal state — this migration does not touch their
--      semantics).
--   3. `idempotency_key` + a partial unique index: the enqueue-idempotency
--      guarantee for "cannot double-bill Anthropic on retry" lives here,
--      in the database, not in application hope. A duplicate enqueue for
--      the same (job_type, idempotency_key) is rejected at the constraint
--      level; the enqueue helper turns that into "return the existing job".
--   4. `claimed_at` / `claimed_by`: who currently owns an in-flight
--      attempt, and since when — required for stuck-job reclaim (a job
--      claimed longer than the stuck threshold gets requeued).
--   5. `claim_invoice_extract_job` / `reclaim_stuck_invoice_extract_jobs`:
--      the atomic claim (FOR UPDATE SKIP LOCKED) and stuck-reclaim sweep
--      can't be expressed through PostgREST's query builder (no SELECT
--      FOR UPDATE, no CTEs), so they're SQL functions the worker calls via
--      RPC. Both run SECURITY INVOKER (the default) — service_role already
--      has full table DML (0074) and bypasses RLS, so no elevated
--      privilege is needed, and EXECUTE is revoked from PUBLIC and granted
--      only to service_role: no other role should be claiming jobs.

-- ── 1. job_type vocabulary ─────────────────────────────────────────────
alter table public.background_jobs
  drop constraint background_jobs_job_type_check;
alter table public.background_jobs
  add constraint background_jobs_job_type_check check (
    job_type in (
      'invoice_ocr',
      'wine_enrichment',
      'wine_list_pdf',
      'cellar_health',
      'pricing_recommendations',
      'invoice_extract'
    )
  );

-- ── 2. status vocabulary ───────────────────────────────────────────────
alter table public.background_jobs
  drop constraint background_jobs_status_check;
alter table public.background_jobs
  add constraint background_jobs_status_check check (
    status in (
      'queued', 'processing', 'retrying', 'succeeded', 'failed',
      'cancelled', 'dead'
    )
  );

-- ── 3. idempotent enqueue ──────────────────────────────────────────────
alter table public.background_jobs
  add column idempotency_key text,
  add column claimed_at timestamptz,
  add column claimed_by text;

create unique index background_jobs_idempotency_key_uniq
  on public.background_jobs (job_type, idempotency_key)
  where idempotency_key is not null;

comment on column public.background_jobs.idempotency_key is
  'Caller-supplied key (e.g. the subject scan id) unique per job_type. '
  'Enforced by background_jobs_idempotency_key_uniq so a retried enqueue '
  'call cannot create a second job for the same unit of work.';

comment on column public.background_jobs.claimed_at is
  'Set by claim_invoice_extract_job when a worker takes ownership of a '
  '"processing" job. Used by the stuck-job reclaim sweep to find jobs '
  'whose worker died mid-attempt.';

comment on column public.background_jobs.claimed_by is
  'Opaque worker instance identifier (e.g. hostname:pid). Used as a '
  'fencing token: completion writes are conditioned on claimed_by still '
  'matching, so a zombie worker cannot clobber a job that has since been '
  'reclaimed by another worker.';

-- ── 4. claim + reclaim indexes ─────────────────────────────────────────
-- Atomic claim: WHERE job_type = ? AND status = 'queued' AND run_after <= now()
-- ORDER BY run_after — the existing background_jobs_restaurant_status_idx
-- is keyed by restaurant_id first, which doesn't help a claim query that
-- deliberately scans across all tenants for the oldest runnable job.
create index background_jobs_claim_idx
  on public.background_jobs (job_type, status, run_after);

-- Stuck-job reclaim: WHERE status = 'processing' AND claimed_at < cutoff.
create index background_jobs_claimed_idx
  on public.background_jobs (status, claimed_at)
  where status = 'processing';

-- ── 5. atomic claim ─────────────────────────────────────────────────────
create function public.claim_invoice_extract_job(p_worker_id text)
returns setof public.background_jobs
language sql
as $$
  with claimable as (
    select id
    from public.background_jobs
    where job_type = 'invoice_extract'
      and status = 'queued'
      and run_after <= now()
    order by run_after
    for update skip locked
    limit 1
  )
  update public.background_jobs b
  set status = 'processing',
      claimed_at = now(),
      claimed_by = p_worker_id,
      started_at = now()
  from claimable
  where b.id = claimable.id
  returning b.*;
$$;

comment on function public.claim_invoice_extract_job(text) is
  'Atomically claims the single oldest runnable invoice_extract job via '
  'FOR UPDATE SKIP LOCKED, so concurrent worker instances never claim the '
  'same row. Returns zero or one row.';

revoke all on function public.claim_invoice_extract_job(text) from public;
grant execute on function public.claim_invoice_extract_job(text) to service_role;

-- ── 6. stuck-job reclaim ────────────────────────────────────────────────
create function public.reclaim_stuck_invoice_extract_jobs(p_stuck_after_seconds integer)
returns setof public.background_jobs
language sql
as $$
  with stuck as (
    select id
    from public.background_jobs
    where job_type = 'invoice_extract'
      and status = 'processing'
      and claimed_at < now() - make_interval(secs => p_stuck_after_seconds)
    for update skip locked
  )
  update public.background_jobs b
  set status = case
        when b.attempt_count + 1 >= b.max_attempts then 'dead'
        else 'queued'
      end,
      attempt_count = b.attempt_count + 1,
      claimed_at = null,
      claimed_by = null,
      run_after = now(),
      finished_at = case
        when b.attempt_count + 1 >= b.max_attempts then now()
        else null
      end,
      error_code = 'stuck_reclaimed',
      error_message = 'Reclaimed: claimed longer than the stuck threshold '
        || 'without completing.'
  from stuck
  where b.id = stuck.id
  returning b.*;
$$;

comment on function public.reclaim_stuck_invoice_extract_jobs(integer) is
  'Sweeps every invoice_extract job claimed longer than p_stuck_after_seconds '
  'ago (worker crashed or was killed mid-attempt) and requeues it with '
  'attempt_count incremented, or marks it dead once max_attempts is '
  'exhausted. Safe to run concurrently with claims and with itself.';

revoke all on function public.reclaim_stuck_invoice_extract_jobs(integer) from public;
grant execute on function public.reclaim_stuck_invoice_extract_jobs(integer) to service_role;

-- === 0076_csv_import_batches.sql ===
-- 0076_csv_import_batches.sql
--
-- G1-4: bulk cellar onboarding via CSV import.
--
-- Two new tables carry the durable state a resumable, reversible import
-- needs — batch-level accounting (import_batches) and row-level state
-- (import_batch_rows), per the plan bar: "row-level atomicity with
-- batch-level accounting, not one giant transaction that can time out on
-- big files." Every row a CSV produces gets exactly one
-- import_batch_rows record the moment the batch is confirmed (a single
-- multi-row INSERT — atomic on its own, no PL/pgSQL loop needed for
-- that part). Applying a batch then walks its rows in bounded chunks
-- (apply_import_batch_chunk), each row's wine-lookup + inventory-insert +
-- row-status-update wrapped in its own PL/pgSQL exception block so one
-- bad row can never abort the rest of the chunk, and a row already
-- applied is simply skipped by the eligibility WHERE clause — safe to
-- call apply_import_batch_chunk again after a timeout, a crash, or a
-- deliberate pause with zero risk of double-applying or half-writing a
-- row.
--
-- No background_jobs / worker involvement (see docs/runbooks/
-- csv-import.md for the documented threshold and the decision not to
-- wire the G1-6 runner here): the Railway worker service is not deployed
-- anywhere yet, and chunked synchronous apply calls, each bounded to a
-- handful of rows, comfortably cover the realistic size of a
-- restaurant's existing cellar (hundreds to low thousands of SKUs) —
-- there is no route handler in this migration's feature that risks a
-- platform timeout in the first place, so trading that away for a
-- from-scratch dependency on an undeployed worker is not a good trade
-- today.
--
-- Authorization model: every function here is SECURITY INVOKER (the
-- default) and granted to `authenticated`, not `service_role`. Unlike
-- G1-6's runner (a trusted background process using the service role,
-- which bypasses RLS entirely), these functions run as whichever member
-- calls them — so table RLS (added below) is the actual tenant boundary,
-- the same trust model as every other member-facing mutation in this
-- app (see stock_adjustments, background_jobs). A cross-tenant call
-- fails closed: the initial row lookup inside each function is itself
-- RLS-filtered, so a batch id belonging to another restaurant is simply
-- invisible, not merely "rejected after being read."
--
-- added_via is deliberately left alone. CSV-imported inventory rows keep
-- added_via = 'manual' rather than adding a new enum value — Postgres
-- enum types cannot drop a value, which is exactly what made G1-6's
-- first attempt at a down migration fail (rows already using the new
-- job_type/status vocabulary couldn't exist under the constraints being
-- restored). Provenance here is tracked precisely by
-- import_batch_rows.applied_inventory_item_id (which batch AND which row
-- created a given inventory row) — strictly more informative than a
-- coarse enum tag, and it keeps this migration's down path a plain
-- DROP TABLE with no destructive row surgery required.

-- ── 1. import_batches ───────────────────────────────────────────────────
create table public.import_batches (
  id             uuid        primary key default gen_random_uuid(),
  restaurant_id  uuid        not null references public.restaurants(id) on delete cascade,
  created_by     uuid        references auth.users(id) on delete set null,
  filename       text        not null,
  status         text        not null default 'created' check (
    status in ('created', 'applying', 'completed', 'reverted')
  ),
  total_rows     integer     not null check (total_rows >= 0),
  reverted_at    timestamptz,
  reverted_by    uuid        references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table public.import_batches is
  'One row per confirmed CSV cellar import. Row-level detail (validation, '
  'LWIN match, apply/revert state) lives in import_batch_rows — this table '
  'is batch-level accounting only. status is a convenience projection the '
  'API recomputes from import_batch_rows after every apply/resolve call, '
  'not an independent source of truth.';

comment on column public.import_batches.status is
  'created: rows persisted, apply not yet run (or not yet finished — see '
  'applying). applying: at least one apply chunk has run but eligible '
  'rows remain, or unresolved rows are still pending operator action. '
  'completed: every row has a final fate (applied, system/operator-'
  'excluded) and nothing is pending. reverted: a completed batch was '
  'rolled back — see revert_import_batch.';

create index import_batches_restaurant_idx
  on public.import_batches (restaurant_id, created_at desc);

create trigger import_batches_set_updated_at
  before update on public.import_batches
  for each row execute function public.set_updated_at();

alter table public.import_batches enable row level security;

create policy "members can read import batches"
  on public.import_batches for select
  using (public.is_member(restaurant_id));

create policy "members can create own import batches"
  on public.import_batches for insert
  with check (
    public.is_member_with_role(restaurant_id, 'staff')
    and created_by = auth.uid()
  );

-- Needed for the API's status recompute after apply/resolve calls, and
-- for revert_import_batch's own status transition. No delete policy —
-- a batch is never removed, only reverted (status transition, audit
-- trail preserved).
create policy "members can update own import batches"
  on public.import_batches for update
  using      (public.is_member_with_role(restaurant_id, 'staff'))
  with check (public.is_member_with_role(restaurant_id, 'staff'));

-- 0074 granted table DML to `authenticated` once, for the tables that
-- existed at the time, and only extended ALTER DEFAULT PRIVILEGES going
-- forward for `service_role` — not `authenticated`. A brand new table
-- like this one therefore starts with NO base table privilege for
-- `authenticated` at all (RLS policies alone are not enough; Postgres
-- checks the base GRANT first). Every table this migration adds needs
-- this explicit grant, or every policy above is unreachable.
grant select, insert, update on table public.import_batches to authenticated;
-- No delete policy exists (batches are a permanent audit trail) —
-- explicitly withhold DELETE too, the same belt-and-suspenders the
-- immutable stock_adjustments table (0063) uses.
revoke delete on table public.import_batches from authenticated;

-- ── 2. import_batch_rows ─────────────────────────────────────────────────
create table public.import_batch_rows (
  id                        uuid        primary key default gen_random_uuid(),
  batch_id                  uuid        not null references public.import_batches(id) on delete cascade,
  restaurant_id             uuid        not null references public.restaurants(id) on delete cascade,
  row_number                integer     not null check (row_number > 0),
  raw                       jsonb       not null,
  row_state                 text        not null check (row_state in ('valid', 'error')),
  validation_errors         jsonb       not null default '[]'::jsonb,
  lwin_status               text        not null default 'unmatched' check (
    lwin_status in ('matched', 'unmatched')
  ),
  lwin_id                   text,
  lwin_score                real,
  cost_status               text        not null default 'present' check (
    cost_status in ('present', 'missing')
  ),
  resolution                text        not null default 'auto' check (
    resolution in ('auto', 'pending', 'include', 'exclude')
  ),
  manual_unit_cost          numeric(10,2) check (manual_unit_cost is null or manual_unit_cost >= 0),
  apply_status              text        not null default 'not_applied' check (
    apply_status in ('not_applied', 'applied', 'reverted')
  ),
  applied_inventory_item_id uuid        references public.inventory_items(id) on delete set null,
  applied_wine_id           uuid        references public.wines(id) on delete set null,
  resolved_at               timestamptz,
  resolved_by               uuid        references auth.users(id) on delete set null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (batch_id, row_number),
  -- A row that failed schema validation can never be applied — it is
  -- permanently system-excluded, not something the operator resolves
  -- via a manual-cost or include/exclude action (fixing it means
  -- correcting the source CSV and re-importing).
  constraint import_batch_rows_error_excluded
    check (row_state <> 'error' or resolution = 'exclude'),
  -- An 'applied' row must always carry the id of the inventory row it
  -- created — that id is what revert_import_batch deletes, and this
  -- constraint guarantees revert can never lose track of it.
  constraint import_batch_rows_applied_has_inventory_id
    check (apply_status <> 'applied' or applied_inventory_item_id is not null)
);

comment on table public.import_batch_rows is
  'One row per CSV data row in a confirmed import batch. raw holds the '
  'parsed (formula-neutralized) cell values keyed by canonical field name '
  '(producer, name, vintage, varietal, region, country, size_ml, format, '
  'currency, quantity, unit_cost, bin, section) — the same shape the '
  'preview endpoint computes, so confirm never trusts a client-supplied '
  'preview payload, it re-derives everything from the uploaded file.';

comment on column public.import_batch_rows.resolution is
  'auto: valid, LWIN-matched (or catalog match not required), cost '
  'present — applies with no operator action. pending: unmatched LWIN '
  'and/or missing cost — held out of apply until the operator resolves '
  'it. include: operator resolved a pending row to proceed anyway '
  '(unmatched rows are created as new, unlinked wines — never silently '
  'fuzzy-merged into a low-confidence LWIN guess). exclude: system '
  '(error rows) or operator decision to leave the row out of inventory '
  'permanently.';

comment on column public.import_batch_rows.apply_status is
  'not_applied: not yet written to inventory (either not eligible yet, '
  'or eligible but not yet processed by an apply chunk — safe to retry). '
  'applied: inventory_items row created; applied_inventory_item_id names '
  'it. reverted: was applied, then removed by revert_import_batch.';

create index import_batch_rows_restaurant_idx
  on public.import_batch_rows (restaurant_id);

-- Matches apply_import_batch_chunk's eligibility WHERE clause exactly,
-- so a chunk call on a large batch doesn't degrade to a sequential scan
-- once most rows are already applied.
create index import_batch_rows_apply_eligible_idx
  on public.import_batch_rows (batch_id, row_number)
  where apply_status = 'not_applied' and row_state = 'valid'
    and resolution in ('auto', 'include');

-- The operator-facing "needs resolution" bucket (LWIN-unmatched and/or
-- missing-cost rows nobody has decided on yet).
create index import_batch_rows_pending_idx
  on public.import_batch_rows (batch_id)
  where resolution = 'pending';

create trigger import_batch_rows_set_updated_at
  before update on public.import_batch_rows
  for each row execute function public.set_updated_at();

alter table public.import_batch_rows enable row level security;

create policy "members can read import batch rows"
  on public.import_batch_rows for select
  using (public.is_member(restaurant_id));

create policy "members can create import batch rows"
  on public.import_batch_rows for insert
  with check (public.is_member_with_role(restaurant_id, 'staff'));

-- No delete policy — rows are a permanent audit trail, including after
-- revert (apply_status flips to 'reverted', the row itself stays).
create policy "members can update import batch rows"
  on public.import_batch_rows for update
  using      (public.is_member_with_role(restaurant_id, 'staff'))
  with check (public.is_member_with_role(restaurant_id, 'staff'));

grant select, insert, update on table public.import_batch_rows to authenticated;
revoke delete on table public.import_batch_rows from authenticated;

-- ── 3. match_lwin_bulk — one-round-trip LWIN preview matching ───────────
-- Preview must do zero database writes but still resolve LWIN match
-- status for every row in one request. Calling match_lwin (0007) once
-- per row from the API would mean one RPC round trip per CSV row; this
-- wraps it in a single set-returning call instead, reusing match_lwin's
-- existing trigram-similarity logic rather than forking it. idx lets the
-- caller zip results back onto its input array (LEFT JOIN LATERAL keeps
-- unmatched queries in the output as null-lwin_id rows instead of
-- dropping them).
create or replace function public.match_lwin_bulk(p_queries jsonb, p_threshold float default 0.3)
returns table (
  idx          integer,
  lwin_id      text,
  display_name text,
  producer     text,
  varietal     text,
  region       text,
  country      text,
  colour       text,
  score        float
)
language sql
stable
security invoker
set search_path = public
as $$
  select q.idx, m.lwin_id, m.display_name, m.producer, m.varietal,
         m.region, m.country, m.colour, m.score
  from jsonb_to_recordset(p_queries) as q(idx integer, producer text, name text)
  left join lateral public.match_lwin(q.producer, q.name, p_threshold) m on true;
$$;

comment on function public.match_lwin_bulk(jsonb, float) is
  'Read-only bulk wrapper around match_lwin (0007) for CSV import preview '
  '— p_queries is a jsonb array of {idx, producer, name}. SECURITY '
  'INVOKER: it performs no writes and match_lwin (SECURITY DEFINER) '
  'already handles the lwin_catalog read, so no elevated privilege is '
  'needed here.';

revoke all on function public.match_lwin_bulk(jsonb, float) from public;
grant execute on function public.match_lwin_bulk(jsonb, float) to authenticated;

-- ── 4. apply_import_batch_chunk — bounded, resumable, row-atomic apply ──
create or replace function public.apply_import_batch_chunk(p_batch_id uuid, p_limit integer default 50)
returns table (
  row_id            uuid,
  row_number        integer,
  outcome           text,
  inventory_item_id uuid,
  error_message     text
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row public.import_batch_rows%rowtype;
  v_unit_cost numeric(10,2);
  v_wine_id uuid;
  v_inventory_id uuid;
begin
  for v_row in
    select r.*
    from public.import_batch_rows r
    where r.batch_id = p_batch_id
      and r.apply_status = 'not_applied'
      and r.row_state = 'valid'
      and r.resolution in ('auto', 'include')
    order by r.row_number
    limit least(greatest(p_limit, 1), 500)
    for update skip locked
  loop
    begin
      if v_row.cost_status = 'missing' then
        if v_row.manual_unit_cost is null then
          row_id := v_row.id;
          row_number := v_row.row_number;
          outcome := 'blocked';
          inventory_item_id := null;
          error_message := 'Missing unit cost has no operator-provided value.';
          return next;
          continue;
        end if;
        v_unit_cost := v_row.manual_unit_cost;
      else
        v_unit_cost := nullif(v_row.raw ->> 'unit_cost', '')::numeric(10,2);
      end if;

      if v_unit_cost is null then
        row_id := v_row.id;
        row_number := v_row.row_number;
        outcome := 'blocked';
        inventory_item_id := null;
        error_message := 'Row has no usable unit cost.';
        return next;
        continue;
      end if;

      -- Same dedup key as find_or_create_wines_batch (0006): reuse the
      -- existing wine if this restaurant already has one, fill in only
      -- the fields that were previously null, never overwrite.
      insert into public.wines (
        restaurant_id, name, producer, vintage, varietal, region, country, size_ml, lwin_id
      ) values (
        v_row.restaurant_id,
        v_row.raw ->> 'name',
        v_row.raw ->> 'producer',
        nullif(v_row.raw ->> 'vintage', '')::int,
        nullif(v_row.raw ->> 'varietal', ''),
        nullif(v_row.raw ->> 'region', ''),
        nullif(v_row.raw ->> 'country', ''),
        coalesce(nullif(v_row.raw ->> 'size_ml', '')::int, 750),
        v_row.lwin_id
      )
      on conflict (restaurant_id, lower(producer), lower(name), coalesce(vintage, 0), size_ml)
      do update set
        varietal = coalesce(public.wines.varietal, excluded.varietal),
        region   = coalesce(public.wines.region, excluded.region),
        country  = coalesce(public.wines.country, excluded.country),
        lwin_id  = coalesce(public.wines.lwin_id, excluded.lwin_id)
      returning id into v_wine_id;

      -- Defensive: an INSERT/ON-CONFLICT-DO-UPDATE...RETURNING that
      -- somehow yields no row must never silently fall through to
      -- marking this row applied with a dangling reference — fail this
      -- row loudly (caught below, retried on the next apply call)
      -- instead.
      if v_wine_id is null then
        raise exception 'wine insert/lookup returned no row for import_batch_row %', v_row.id;
      end if;

      insert into public.inventory_items (
        wine_id, restaurant_id, quantity, unit_cost, bin_location, section, format, currency, added_via
      ) values (
        v_wine_id,
        v_row.restaurant_id,
        coalesce(nullif(v_row.raw ->> 'quantity', '')::int, 0),
        v_unit_cost,
        nullif(v_row.raw ->> 'bin', ''),
        nullif(v_row.raw ->> 'section', ''),
        nullif(v_row.raw ->> 'format', ''),
        nullif(v_row.raw ->> 'currency', ''),
        'manual'
      )
      returning id into v_inventory_id;

      if v_inventory_id is null then
        raise exception 'inventory_items insert returned no row for import_batch_row %', v_row.id;
      end if;

      update public.import_batch_rows
      set apply_status = 'applied',
          applied_inventory_item_id = v_inventory_id,
          applied_wine_id = v_wine_id,
          updated_at = now()
      where id = v_row.id;

      row_id := v_row.id;
      row_number := v_row.row_number;
      outcome := 'applied';
      inventory_item_id := v_inventory_id;
      error_message := null;
      return next;
    exception when others then
      -- Caught per-row (an implicit savepoint) so one bad row can never
      -- take the rest of the chunk down with it. The row stays
      -- 'not_applied' and is retried on the next apply call.
      row_id := v_row.id;
      row_number := v_row.row_number;
      outcome := 'error';
      inventory_item_id := null;
      error_message := sqlerrm;
      return next;
    end;
  end loop;
end;
$$;

comment on function public.apply_import_batch_chunk(uuid, integer) is
  'Applies up to p_limit not-yet-applied, eligible rows of one import '
  'batch. FOR UPDATE SKIP LOCKED means concurrent/duplicate calls for '
  'the same batch never double-apply a row. Each row''s wine-lookup + '
  'inventory-insert + row-status-update is wrapped in its own exception '
  'block, so a single row failing never blocks or half-applies the '
  'others — call again to retry whatever remains not_applied. SECURITY '
  'INVOKER: RLS on import_batch_rows/wines/inventory_items is the '
  'tenant boundary, so a batch id from another restaurant is simply '
  'invisible to the initial SELECT and the loop does nothing.';

revoke all on function public.apply_import_batch_chunk(uuid, integer) from public;
grant execute on function public.apply_import_batch_chunk(uuid, integer) to authenticated;

-- ── 5. revert_import_batch — undo exactly what one batch created ────────
create or replace function public.revert_import_batch(p_batch_id uuid)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_restaurant_id uuid;
  v_status text;
  v_row record;
  v_count integer := 0;
begin
  select restaurant_id, status into v_restaurant_id, v_status
  from public.import_batches
  where id = p_batch_id
  for update;

  if not found then
    -- RLS already filtered this to "batches I'm a member of" — a
    -- cross-tenant batch id lands here indistinguishable from a
    -- nonexistent one, which is the point.
    raise exception 'import batch % not found', p_batch_id using errcode = 'P0002';
  end if;

  if v_status <> 'completed' then
    raise exception 'import batch % is not completed (status=%)', p_batch_id, v_status
      using errcode = 'P0001';
  end if;

  for v_row in
    select id, applied_inventory_item_id
    from public.import_batch_rows
    where batch_id = p_batch_id and apply_status = 'applied'
    for update
  loop
    -- Order matters here. import_batch_rows_applied_has_inventory_id
    -- (0076) requires applied_inventory_item_id IS NOT NULL whenever
    -- apply_status = 'applied'. applied_inventory_item_id references
    -- inventory_items ON DELETE SET NULL, so deleting the inventory row
    -- FIRST fires that FK action immediately — nulling the column while
    -- apply_status here is STILL 'applied' — and violates the very
    -- constraint that's supposed to prevent this state. Flipping
    -- apply_status to 'reverted' (and nulling the column ourselves)
    -- first means the constraint's exception is already satisfied
    -- before the delete's FK action can touch the row at all.
    update public.import_batch_rows
    set apply_status = 'reverted',
        applied_inventory_item_id = null,
        updated_at = now()
    where id = v_row.id;

    -- Deletes only the inventory_items row THIS row created — never
    -- touches any other row, including pre-existing inventory for the
    -- same wine or same restaurant.
    delete from public.inventory_items
    where id = v_row.applied_inventory_item_id
      and restaurant_id = v_restaurant_id;

    v_count := v_count + 1;
  end loop;

  update public.import_batches
  set status = 'reverted', reverted_at = now(), reverted_by = auth.uid()
  where id = p_batch_id;

  return v_count;
end;
$$;

comment on function public.revert_import_batch(uuid) is
  'Reverts one completed batch: deletes exactly the inventory_items rows '
  'recorded in applied_inventory_item_id for this batch''s applied rows '
  '(never wines, never another batch''s or another source''s inventory '
  'rows), flips those rows to reverted, and the batch to reverted. Only '
  'callable on a batch in status = completed. Returns the count of rows '
  'reverted. reverted_by is auth.uid() — the invoking session''s own '
  'identity, never a client-supplied value.';

revoke all on function public.revert_import_batch(uuid) from public;
grant execute on function public.revert_import_batch(uuid) to authenticated;

-- === 0097_canonical_wines.sql ===
-- 0097_canonical_wines.sql
-- P2 — wine identity spine, part 1: the global identity table.
--
-- canonical_wines is the internal, immutable identity a real-world wine
-- (producer + cuvée, no vintage/size) gets exactly once, ever, regardless of
-- how many tenants carry it or how many times its name is misspelled on a
-- CSV. It is deliberately NOT restaurant-scoped: two restaurants' imports of
-- "Domaine Jean Grivot, Vosne-Romanée" must resolve to the same row so a
-- later image/enrichment pass (P4) can serve one cached asset to both,
-- without either tenant's inventory ever becoming visible to the other
-- (that boundary lives entirely in wine_variants/wines, not here).
--
-- LWIN (lwin7) participates as an alias/anchor, never as the primary key —
-- see docs/plans/2026-08-23-p2-identity-spine.md §1 for why: a bad fuzzy
-- LWIN match must never be able to retroactively invalidate this row's
-- identity (the C24 failure mode). vintage and bottle size are NEVER part
-- of this table — they are wine_variants' job (0098) and are always exact
-- keys, never fuzzy-matched (see resolve_wine_variants_bulk, 0099).

-- P2 ROUND-6 FIX (D9-residual #2 — see the identity_normalize_text() and
-- canonical_wines DDL comments below): the extension + normalization
-- function are declared BEFORE the table, because the table's identity
-- key columns are now GENERATED from this function and a generation
-- expression cannot reference a function that does not exist yet.
create extension if not exists unaccent;

-- P2 ROUND-5/6 FIX (D9-residual — scratchpad db-audit/verify/P2-critic-r4.md):
-- shared, deterministic text-normalization helper. Round 4's LWIN
-- corroboration gate used pg_trgm similarity() with match_lwin's ranking
-- thresholds (0.3/0.21) — a threshold tuned to be TOLERANT of false
-- positives because a human reviews match_lwin's suggestions. That is the
-- wrong tool for a permanent, cross-tenant, unrepairable security
-- decision: similarity('Chateau Pichon Longueville Baron', 'Chateau
-- Pichon Longueville Comtesse de Lalande') = 0.55, comfortably above 0.3,
-- for two REAL, DISTINCT Bordeaux estates that share a long common
-- prefix — live-verified against this exact pair before writing this
-- comment. A fuzzy threshold cannot separate them; no threshold reliably
-- can, because their similarity is a property of shared vocabulary, not
-- of being the same wine.
--
-- identity_normalize_text() replaces the threshold with a DETERMINISTIC
-- equality check: unaccent + lowercase + possessive-suffix merge +
-- collapse non-alnum + token-sort. Baron and Lalande normalize to
-- different token sets ("baron chateau longueville pichon" vs "chateau
-- comtesse de lalande longueville pichon") and can never satisfy an
-- equality check regardless of shared vocabulary, while a genuine
-- data-entry-error — accents, case, spacing, punctuation — still
-- normalizes identically on both sides, preserving the legitimate "LWIN
-- wins over textual FORMATTING differences" behavior
-- resolve_wine_variants_bulk depends on.
--
-- ROUND 6 — TWO CHANGES, both forced by this function's PROMOTION from
-- "comparison helper" to "the definition of the identity key" (the
-- canonical_wines DDL below now GENERATES producer_norm/cuvee_norm from
-- it). While it only ever fed comparisons, divergence from the
-- TypeScript src/domains/identity/normalize.ts was cosmetic and its
-- worst case was a false NEGATIVE. Once it computes the stored identity
-- key, a divergence becomes a false POSITIVE — two genuinely different
-- wines sharing one canonical row — which is the single failure the
-- blueprint cares about most:
--
-- 1. POSSESSIVE-SUFFIX RULE ADDED (the D3 regression, live-measured).
--    normalize.ts merges a trailing possessive "'s" into its host word
--    BEFORE the general non-alnum collapse, so "O'Brien's" -> "briens"
--    (one token) rather than "brien"+"s" (two tokens, one a
--    coincidence-prone stray). Without that rule here, "O'Brien's
--    Vineyard" and "O.S. Brien Vineyard" BOTH normalized to
--    "brien o s vineyard" — the exact over-merge round 2's D3 fix
--    removed from the TypeScript side, silently reintroduced the moment
--    the identity key moved into SQL. Measured against the frozen
--    contract in src/domains/identity/__fixtures__/normalization-golden-
--    vectors.json: 10 of 17 vectors agreed before this rule, 17 of 17
--    after, and all 7 failures were this one cause. The regexp is the
--    direct translation of normalize.ts's /['’]s(?=\s|$)/g — PostgreSQL's
--    ARE engine has no lookahead here, so the following-space is captured
--    and re-emitted via \1 instead.
-- 2. search_path PINNED. unaccent(text) is declared STABLE, not
--    IMMUTABLE, and resolves BOTH the function and its dictionary through
--    search_path; this function's IMMUTABLE marking was therefore a
--    promise rather than a guarantee (as its previous comment honestly
--    disclosed). A promise is survivable for a comparison; it is not
--    survivable for a STORED GENERATED column, where the value is
--    computed once and then indexed as a UNIQUE identity key. Pinning
--    search_path (the same discipline is_member and every other
--    security-relevant function in this schema already uses, 0001) makes
--    the resolution deterministic and the immutability marking honest.
create or replace function public.identity_normalize_text(raw text)
returns text
language sql
immutable
parallel safe
set search_path = public
as $$
  select nullif(
    (select string_agg(t, ' ' order by t)
     from unnest(string_to_array(
       trim(regexp_replace(
         regexp_replace(lower(unaccent(raw)), '[''’]s(\s|$)', 's\1', 'g'),
         '[^a-z0-9]+', ' ', 'g')),
       ' '
     )) as t
     where t <> ''),
    ''
  );
$$;

comment on function public.identity_normalize_text(text) is
  'THE definition of canonical_wines'' identity key: producer_norm and '
  'cuvee_norm are STORED GENERATED columns computed by this function, so '
  'no client, RPC, or table-owner migration can supply an identity key '
  'decoupled from the row''s own producer/cuvee text. Also used for '
  'deterministic LWIN corroboration — exact equality (producer) or '
  'token-array subset (cuvee vs display_name, since display_name commonly '
  'combines producer + wine name) — never as a fuzzy/threshold input. '
  'Behaviourally equivalent to src/domains/identity/normalize.ts''s '
  'normalizeProducerOrCuvee; that equivalence is enforced unconditionally '
  'by src/domains/identity/normalize.test.ts against the frozen golden '
  'vectors, and it is load-bearing rather than tidy — a divergence here '
  'is a false POSITIVE (two different wines sharing one canonical row), '
  'not the false negative it was while this function only fed '
  'comparisons.';

create table public.canonical_wines (
  id                     uuid        primary key default gen_random_uuid(),
  producer               text        not null,
  cuvee                  text        not null,
  -- P2 ROUND-6 FIX (D9-residual #2 — the second cross-tenant identity-
  -- hijack instance, live-reproduced end to end before this fix):
  -- these two columns ARE the identity key (canonical_wines_identity_idx
  -- below is UNIQUE on them, and resolve_wine_variants_bulk's phase-1
  -- text match joins on them), and until round 6 they were plain
  -- caller-supplied text. The LWIN corroboration gate validated
  -- producer/cuvee — a DIFFERENT pair of caller-supplied fields —
  -- so the value checked and the value stored were simply not the same
  -- thing, with nothing anywhere binding one to the other.
  --
  -- The attack needed no threshold, no fuzzy matching and no unusual
  -- privilege: submit raws for a wine you legitimately own whose lwin7
  -- genuinely corroborates, and norms naming the VICTIM's wine. The gate
  -- passes on the raws; the row lands on the victim's identity key as
  -- lwin_verified. Reproduced live against this stack: a row reading
  -- producer='Attacker Real Estate' (which is what corroborated its
  -- lwin7) was written with producer_norm='estate real victim', and the
  -- victim's own subsequent, entirely correct import through the real
  -- resolve_wine_variants_bulk RPC then bound to it — canonical_match_
  -- method='exact', canonical_created=false. Permanent and unrepairable
  -- by the victim: canonical_wines_identity_idx is UNIQUE so they can
  -- never create their own row, and this table grants authenticated no
  -- UPDATE or DELETE.
  --
  -- GENERATED ALWAYS ... STORED is the fix, chosen over a CHECK
  -- constraint deliberately. A CHECK would still let the caller supply
  -- the key and merely police it; generation removes the field from
  -- every write API outright, so the decoupling is not defended against,
  -- it is unrepresentable. It reaches paths RLS cannot: 0101's backfill
  -- runs as the table owner and bypasses RLS entirely, and
  -- resolve_wine_variants_bulk is SECURITY INVOKER but batches its
  -- inserts. Attempting to supply either column now fails with SQLSTATE
  -- 428C9 from any role, including service_role and the table owner.
  --
  -- NOT NULL is retained and is load-bearing in the fail-closed
  -- direction: identity_normalize_text returns NULL when the input
  -- collapses to nothing (e.g. punctuation-only text), so such a row is
  -- refused outright rather than inventing a placeholder identity. Both
  -- 0099 and 0101 already delete those rows before reaching an insert,
  -- so this changes no supported path — it only closes the direct-insert
  -- one.
  producer_norm          text        not null generated always as (public.identity_normalize_text(producer)) stored,
  cuvee_norm             text        not null generated always as (public.identity_normalize_text(cuvee)) stored,
  colour                 text,
  region                 text,
  country                text,
  lwin7                  text        check (lwin7 ~ '^[0-9]{7}$'),
  identity_status        text        not null default 'unverified' check (
    identity_status in ('lwin_verified', 'operator_confirmed', 'unverified')
  ),
  created_by_restaurant_id uuid      references public.restaurants(id) on delete set null,
  created_by_user_id     uuid        references auth.users(id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

comment on table public.canonical_wines is
  'Global (not restaurant-scoped) real-world wine identity: producer + '
  'cuvée, no vintage/size. created_by_* is audit metadata only, never a '
  'tenancy boundary — every authenticated tenant can read and (shape-'
  'restricted) insert into this table by design, since it is a shared '
  'catalog every import contributes to. See the migration header and '
  'docs/plans/2026-08-23-p2-identity-spine.md §8 for the anti-pollution '
  'reasoning: access control cannot lock this table down without also '
  'blocking legitimate long-tail wine creation, so correctness is '
  'enforced on WHAT a row may assert (identity_status/lwin7 shape), not '
  'WHO may write it.';

create unique index canonical_wines_identity_idx
  on public.canonical_wines (producer_norm, cuvee_norm);

create unique index canonical_wines_lwin7_idx
  on public.canonical_wines (lwin7)
  where lwin7 is not null;

create index canonical_wines_producer_trgm_idx
  on public.canonical_wines using gin (producer_norm gin_trgm_ops);

create index canonical_wines_cuvee_trgm_idx
  on public.canonical_wines using gin (cuvee_norm gin_trgm_ops);

create trigger canonical_wines_set_updated_at
  before update on public.canonical_wines
  for each row execute function public.set_updated_at();

alter table public.canonical_wines enable row level security;

create policy "anyone authenticated can read canonical_wines"
  on public.canonical_wines for select to authenticated
  using (true);

-- Shape-restricted insert, not ownership-restricted (there is no owner to
-- check on a global table): a raw client/RPC insert may only claim
-- 'unverified' outright, or 'lwin_verified' when it also supplies a lwin7
-- that DETERMINISTICALLY corroborates against the real catalog (see
-- below). 'operator_confirmed' is intentionally NEVER reachable through
-- this policy — nothing in P2 sets it; it exists in the CHECK constraint
-- for a future manager-gated promotion RPC, out of scope here
-- (docs/plans/2026-08-23-p2-identity-spine.md §12).
--
-- P2 ROUND-4/5 HISTORY (D9, then D9-residual — scratchpad
-- db-audit/verify/P2-critic-r3.md and -r4.md): round 1 only checked
-- lwin7's FORMAT. Round 4 added a corroboration check using pg_trgm
-- similarity() at match_lwin's own ranking thresholds (0.3/0.21) — WRONG:
-- that threshold is tuned to be tolerant of false positives because a
-- human reviews match_lwin's suggestions; this policy makes a permanent,
-- cross-tenant, unrepairable decision. The round-5 critic proved live
-- that similarity('Chateau Pichon Longueville Baron', 'Chateau Pichon
-- Longueville Comtesse de Lalande') = 0.55 — two REAL, DISTINCT estates,
-- both comfortably above 0.3 — then reproduced the full cross-tenant
-- hijack through all three enforcement copies using nothing but the
-- system's OWN real data (no attacker needed): tenant A submits
-- Lalande's own correct text with Baron's real lwin7; the (then-fuzzy)
-- gate accepted it as lwin_verified; tenant B later submits Baron's own
-- correct text with the same lwin7, and because LWIN-exact wins by
-- design, tenant B bound to tenant A's Lalande-labelled row.
--
-- The round-5 critic ALSO found a second, more severe hole: the
-- 'unverified' branch below placed NO constraint on lwin7 at all, so a
-- row could squat a real lwin7 as 'unverified' garbage — the
-- corroboration check never even ran — and 0099's phase-1 lwin_exact
-- match had no identity_status filter, so EVERY later import carrying
-- that lwin7, including a fully legitimate one, matched the squatter.
-- That path needed no fuzzy match, no attacker cleverness, and did not
-- go through this policy's 'lwin_verified' branch at all.
--
-- Round 5 fixes BOTH, structurally rather than by tuning a constant:
--
-- 1. NEW CHECK CONSTRAINT canonical_wines_lwin7_requires_verified below:
--    lwin7 may be non-null ONLY when identity_status = 'lwin_verified'.
--    This is a table-level CHECK, not an RLS policy clause, so it is
--    enforced for EVERY insert path universally — the authenticated RLS
--    policy here, resolve_wine_variants_bulk (SECURITY INVOKER, so RLS
--    already applied, but defense-in-depth matters), AND 0101's backfill
--    (which runs as the table owner and bypasses RLS entirely — this
--    CHECK constraint is the only thing that reaches it). Closes the
--    unverified-squat path outright: there is no longer any insert shape
--    that lets lwin7 through without the corroboration check below also
--    having to pass.
-- 2. The corroboration check itself is now DETERMINISTIC, not fuzzy:
--    identity_normalize_text() (defined above) applied to both sides.
--    PRODUCER is compared for EXACT equality — this is what actually
--    separates Baron from Lalande (their normalized forms differ), while
--    still tolerating genuine data-entry-error formatting differences
--    (accents/case/spacing/punctuation collapse identically on both
--    sides). CUVEE is compared by TOKEN SUBSET, not exact equality:
--    lwin_catalog.display_name commonly combines producer + wine name
--    (verified against this table's own seed data), so an exact-string
--    check against cuvee alone would reject every legitimate match. A
--    submitted cuvee whose normalized tokens are ALL present in
--    display_name's normalized tokens is accepted; a wrong cuvee (e.g.
--    the real producer's LWIN attached to a fabricated bottling name)
--    is not. Both comparisons are still deterministic set/string
--    operations, never a score — which is what makes resolve_wine_
--    variants_bulk's "LWIN wins over textual FORMATTING differences"
--    feature still work
--    for its intended case).
--
-- ROUND 6 (D9-residual #2) — WHY THIS POLICY NEEDS NO producer_norm/
-- cuvee_norm CLAUSE, which is the natural thing to look for here. Round
-- 5 closed the RPC half of the norm/raw decoupling by deriving the norms
-- server-side inside resolve_wine_variants_bulk, but this policy was the
-- other half and was left open: it corroborates the row's own producer/
-- cuvee (correctly) while placing NO constraint whatsoever on the two
-- columns that actually ARE the identity key. A direct insert could
-- therefore pass corroboration on honest raws and still land on any
-- victim's key. Adding a `producer_norm = identity_normalize_text(
-- producer)` clause here would have worked, but only for this one path,
-- and only for as long as the clause and the RPC agreed — the same
-- "three copies of one gate" shape the round-4 critic already faulted.
-- Round 6 instead makes the columns GENERATED (see the table DDL above),
-- so a forged identity key is rejected by the column definition itself
-- before any policy is consulted, identically for this policy, the RPC,
-- 0101's table-owner backfill and service_role. That is why the check
-- below is still expressed against producer/cuvee and needs no
-- counterpart: producer/cuvee are now provably the sole inputs to the
-- key, so corroborating them IS corroborating it.
--
-- This RLS policy protects DIRECT inserts. It does NOT, by itself,
-- protect resolve_wine_variants_bulk's own batched insert from aborting
-- the ENTIRE batch the moment one row's lwin7 fails this check (a WITH
-- CHECK violation on any one row of a multi-row INSERT fails the whole
-- statement) — that RPC (0099) carries its own pre-insert corroboration
-- gate (now also deterministic) for exactly that reason, so a bad LWIN
-- downgrades just that one row to unverified instead of aborting a
-- 5,000-row import chunk. 0101's backfill carries its own copy of the
-- corroboration logic too (reusing identity_normalize_text() directly,
-- not duplicating the expression) — the CHECK CONSTRAINT is what makes
-- the OUTCOME safe there even if that logic ever drifted; the RLS
-- policy and the RPC gate exist to make the CREATE decision correct in
-- the first place, not merely safe-by-constraint.
create policy "members can insert canonical_wines"
  on public.canonical_wines for insert to authenticated
  with check (
    identity_status = 'unverified'
    or (
      identity_status = 'lwin_verified'
      and lwin7 is not null
      and exists (
        select 1 from public.lwin_catalog lc
        where lc.lwin_id = lwin7
          -- `canonical_wines.producer`/`.cuvee` MUST be table-qualified
          -- here, not bare — lwin_catalog also has its own `producer`
          -- column, and an unqualified reference inside this subquery
          -- resolves to lc.producer (the subquery's own scope), not the
          -- row being inserted, silently turning this into `x = x`
          -- (always true). Caught live during round-5 verification: the
          -- unqualified form let Pichon Lalande's own text pass
          -- corroboration against Pichon Baron's catalog row, because
          -- the check was accidentally comparing Baron's catalog
          -- producer to itself. `lwin_catalog` has no `cuvee` or
          -- `identity_status` column, so those bare references above are
          -- not at risk — only the two names it happens to share with
          -- canonical_wines.
          and public.identity_normalize_text(canonical_wines.producer) = public.identity_normalize_text(lc.producer)
          and string_to_array(public.identity_normalize_text(canonical_wines.cuvee), ' ') <@ string_to_array(public.identity_normalize_text(lc.display_name), ' ')
      )
    )
  );

-- P2 ROUND-5 FIX (D9-residual): closes the unverified-squat path at the
-- schema level, universally, regardless of insert path or role. See the
-- policy comment above for the full history.
alter table public.canonical_wines
  add constraint canonical_wines_lwin7_requires_verified
  check (lwin7 is null or identity_status = 'lwin_verified');

-- No update/delete policy for authenticated or anon: this table is
-- append-mostly. The only sanctioned mutation paths are
-- resolve_wine_variants_bulk (0099, insert-only) and merge_canonical_wines
-- (0100, service-role only, which both updates referrers and deletes the
-- source row under its own privileges).
--
-- P2 ROUND-2 FIX (D4 — scratchpad db-audit/verify/P2-critic-r1.md):
-- created_by_restaurant_id is audit-only per this table's own design (see
-- the table comment above), but §8 of
-- docs/plans/2026-08-23-p2-identity-spine.md only evaluated that column
-- against a WRITE-corruption threat model and never asked whether a
-- global, any-authenticated-readable table should expose it for READING.
-- The critic reproduced live that it does: any signed-in user at any
-- restaurant can read which OTHER restaurant first stocked a given wine —
-- a narrow but real competitive-intelligence leak, and — combined with
-- 0029_public_restaurant_read.sql's public restaurant-name policy — a
-- restaurant's own name is reachable from it too. Deliberate decision:
-- restrict, not merely document. No app code anywhere reads
-- created_by_restaurant_id or created_by_user_id via the authenticated
-- role (confirmed by grep across src/**), so there is no functional loss,
-- and RETURNING clauses on this table (resolve_wine_variants_bulk, 0099)
-- never reference either column, so this cannot break the one write path
-- that populates them. Column-level GRANT (not a second RLS policy —
-- Postgres RLS is row-level only) is the standard mechanism for
-- restricting a subset of columns on an otherwise-readable table; per
-- has_table_privilege's own semantics (true if the role holds privilege
-- on ANY column), the existing "authenticated can select ...
-- canonical_wines" pgTAP assertion in
-- supabase/tests/0097_identity_spine_grants.sql is unaffected. Both
-- created_by_* columns get the same treatment since they share the exact
-- same audit-only justification and the same platform-wide-read shape —
-- leaving one restricted and its sibling open would be an inconsistency,
-- not a decision.
grant select (
  id, producer, cuvee, producer_norm, cuvee_norm, colour, region, country,
  lwin7, identity_status, created_at, updated_at
) on table public.canonical_wines to authenticated;
grant insert on table public.canonical_wines to authenticated;

-- === 0098_wine_variants.sql ===
-- 0098_wine_variants.sql
-- P2 — wine identity spine, part 2: the tenant-scoped identity table, plus
-- the wines/wine_lineages hooks that let existing per-tenant rows point at
-- it.
--
-- wine_variants is one restaurant's claim on one (canonical_wine, vintage,
-- size) tuple. It is restaurant-scoped (unlike canonical_wines) because
-- Terroir's inventory model is restaurant-scoped SaaS — a global vintage+
-- format catalog shared across tenants would recreate exactly the cross-
-- tenant-write risk C01/C05/C06 already demonstrate elsewhere in this
-- schema. vintage and size_ml are the identity keys here, and per
-- docs/plans/2026-08-23-p2-identity-spine.md §6 they are NEVER fuzzy-
-- matched — only producer/cuvée text (canonical_wines) ever passes through
-- trigram similarity, and only to suggest.
--
-- wines is extended, not replaced: it keeps being the authoritative
-- per-tenant operational row (inventory, pours, pricing, everything
-- accumulated across 96 migrations). wine_variant_id is deliberately NOT
-- unique on wines — two wines rows resolving to the same variant because
-- of spelling drift is the exact "possible duplicate" signal a review
-- surface wants, cheaper to detect (GROUP BY HAVING count(*) > 1) than to
-- prevent by force.

create table public.wine_variants (
  id                uuid        primary key default gen_random_uuid(),
  restaurant_id     uuid        not null references public.restaurants(id) on delete cascade,
  canonical_wine_id uuid        not null references public.canonical_wines(id) on delete restrict,
  vintage           int         check (vintage is null or vintage between 1900 and extract(year from now())::int + 1),
  size_ml           int         not null default 750 check (size_ml > 0),
  lwin11            text        check (lwin11 ~ '^[0-9]{11}$'),
  lwin16            text        check (lwin16 ~ '^[0-9]{16}$'),
  gtin              text        check (gtin ~ '^[0-9]{8,14}$'),
  display_name      text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.wine_variants is
  'One restaurant''s claim on one (canonical_wine_id, vintage, size_ml) '
  'identity tuple. vintage=null means NV, matching the wines.vintage '
  'convention. size_ml — never the free-text wines/inventory_items '
  '"format" column — is the sole identity key for bottle format '
  '(docs/plans/2026-08-23-p2-identity-spine.md §5): "Magnum" vs "1.5L '
  'Magnum" vs "1500ml" all describe size_ml=1500 and must never fork the '
  'identity.';

-- Composite-FK target for wines.wine_variant_id below.
create unique index wine_variants_id_restaurant_idx
  on public.wine_variants (id, restaurant_id);

-- The exact-match identity key. coalesce(vintage,0) matches the existing
-- wines_dedup_idx (0002) convention exactly, so NV variants collide on 0
-- the same way wines.vintage always has.
create unique index wine_variants_identity_idx
  on public.wine_variants (restaurant_id, canonical_wine_id, coalesce(vintage, 0), size_ml);

create unique index wine_variants_gtin_idx
  on public.wine_variants (restaurant_id, gtin)
  where gtin is not null;

create index wine_variants_restaurant_id_idx on public.wine_variants (restaurant_id);
create index wine_variants_canonical_wine_id_idx on public.wine_variants (canonical_wine_id);

create trigger wine_variants_set_updated_at
  before update on public.wine_variants
  for each row execute function public.set_updated_at();

alter table public.wine_variants enable row level security;

create policy "members can read wine_variants"
  on public.wine_variants for select to authenticated
  using (public.is_member(restaurant_id));

create policy "members can insert wine_variants"
  on public.wine_variants for insert to authenticated
  with check (public.is_member(restaurant_id));

create policy "members can update wine_variants"
  on public.wine_variants for update to authenticated
  using (public.is_member(restaurant_id))
  with check (public.is_member(restaurant_id));

-- No delete policy: identity records are permanent audit trail, same
-- posture as import_batches/stock_adjustments.

grant select, insert, update on table public.wine_variants to authenticated;

-------------------------------------------------------------------------------
-- wines hooks
-------------------------------------------------------------------------------

alter table public.wines
  add column wine_variant_id   uuid,
  add column canonical_wine_id uuid references public.canonical_wines(id) on delete set null;

-- C17's own fix sketch (composite FK), applied preventively on a brand-new
-- column: a wines row pointing at another tenant's wine_variant becomes a
-- constraint violation, not a latent cross-tenant bug.
--
-- P2 ROUND-3 FIX (D1-residual — scratchpad db-audit/verify/P2-critic-r2.md):
-- round 1 shipped ON DELETE CASCADE, which let a single wine_variants
-- delete silently destroy the wines row pointing at it plus every one of
-- its own CASCADE-tied audit children — CRITICAL, fixed in round 2 by
-- switching to ON DELETE SET NULL (wine_variant_id), a Postgres 15+
-- column-scoped composite-FK action. Round 2's own comment then rejected
-- plain RESTRICT (round 1's original recommendation, and the posture of
-- the sibling wine_variants_canonical_wine_id_fkey below) on the theory
-- that a restaurant teardown fires wine_variants.restaurant_id's CASCADE
-- and wines.restaurant_id's CASCADE in an unguaranteed order, and RESTRICT
-- would raise a spurious violation if the wine_variants side won that
-- race.
--
-- The round-2 critic tested that specific claim directly rather than
-- reasoning about it: dropped and recreated wines_restaurant_id_fkey to
-- give it deliberately LATER trigger OIDs than
-- wine_variants_restaurant_id_fkey's, added AFTER DELETE diagnostic
-- triggers logging clock_timestamp() to PROVE the reversed order rather
-- than infer it, and reran restaurant teardown under plain RESTRICT.
-- It never fired — 8/8 in natural order, then again under the
-- diagnostically-proven-reversed order. Independently reproduced here
-- (same technique — forced trigger-OID reversal, real NOTICE timestamps
-- confirming wine_variants deleted before wines, plain RESTRICT on the
-- fixture): teardown still succeeded with zero errors. This is consistent
-- with how Postgres actually implements NOT DEFERRABLE FK RESTRICT/
-- NO ACTION checks — as a true end-of-statement check, not a check at the
-- moment the referenced row disappears — so by the time it runs, every
-- cascade delete across the whole affected object graph (both siblings,
-- regardless of which fired first) has already completed, and there is
-- never a live wines row left pointing at an already-deleted
-- wine_variants row for the check to trip on.
--
-- So the justification for SET NULL was wrong, and SET NULL itself
-- reopened a milder version of the SAME failure class round 1 was
-- CRITICAL over: a variant delete that silently severs a wine's resolved
-- identity (wine_variant_id AND canonical_wine_id, both nulled by
-- wines_derive_canonical_wine_id below) with no error, no
-- identity_merge_log entry, and no code path that ever re-heals it.
-- Quieter than destroying the wine, but still an unguarded, unlogged
-- mutation of identity state — exactly what identity_merge_log and the
-- merge-completeness testing apparatus exist to prevent everywhere else.
--
-- Fixed to plain RESTRICT, now that it is proven safe under both natural
-- and forced-reversed cascade ordering. This matches the sibling
-- wine_variants_canonical_wine_id_fkey's posture and the design's own
-- stated philosophy: force an explicit, guarded, logged path (a real
-- merge/detach operation, not a bare DELETE) for any identity-table
-- mutation. Since no current code path deletes a wine_variants row at all
-- (confirmed in round 1), RESTRICT costs nothing today and simply ensures
-- that whenever such a delete IS attempted in the future, it fails loudly
-- instead of silently detaching — forcing whoever writes that future code
-- to go through (or add) a guarded, logged path instead.
-- Regression test (live, real service-role client, full 10-child-table
-- fixture, plus a forced-reversal reproduction): the two "D1 fix" tests
-- at the end of src/domains/identity/merge.test.ts.
alter table public.wines
  add constraint wines_variant_tenant_fk
    foreign key (wine_variant_id, restaurant_id)
    references public.wine_variants(id, restaurant_id)
    on delete restrict;

create index wines_wine_variant_id_idx on public.wines (wine_variant_id);
create index wines_canonical_wine_id_idx on public.wines (canonical_wine_id);

comment on column public.wines.wine_variant_id is
  'Not unique by design — two wines rows sharing a wine_variant_id because '
  'of pre-normalization spelling drift is the possible-duplicate signal, '
  'not an error. See merge_wines (0100) for the sanctioned collapse path.';

comment on column public.wines.canonical_wine_id is
  'Denormalized convenience (avoids a join through wine_variants for '
  'every list/search view). Kept in sync by '
  'wines_derive_canonical_wine_id below, not by convention — a '
  'convention-only invariant here would reproduce the drift C17 '
  'demonstrated for import_batch_rows'' two independently-writable FKs.';

create or replace function public.wines_derive_canonical_wine_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.wine_variant_id is null then
    new.canonical_wine_id := null;
  else
    select canonical_wine_id into new.canonical_wine_id
    from public.wine_variants
    where id = new.wine_variant_id;
  end if;
  return new;
end;
$$;

create trigger wines_derive_canonical_wine_id
  before insert or update of wine_variant_id
  on public.wines
  for each row execute function public.wines_derive_canonical_wine_id();

-------------------------------------------------------------------------------
-- wine_lineages hook — inert light-touch link. No trigger, no backfill,
-- no consumer in P2; exists so a future piece can join tenant lineages to
-- global identity without a schema change.
-------------------------------------------------------------------------------

alter table public.wine_lineages
  add column canonical_wine_id uuid references public.canonical_wines(id) on delete set null;

create index wine_lineages_canonical_wine_id_idx on public.wine_lineages (canonical_wine_id);

-- === 0099_wine_identity_resolution.sql ===
-- 0099_wine_identity_resolution.sql
-- P2 — wine identity spine, part 3: the alias ledger and the dedup
-- service's DB entrypoint.
--
-- wine_aliases is not given its own numbered migration in
-- docs/plans/2026-08-23-p2-identity-spine.md — §0 lists it as an in-scope
-- deliverable and §6-9 describe how it is written and read, but the plan's
-- own §3 migration set never gives it a CREATE TABLE. It is defined here,
-- immediately before the one function that writes it, because it is
-- specifically the dedup service's own spelling corpus (§9 step 6), and
-- because both the canonical- and variant-scoped shapes it needs
-- (§8's tenancy table has separate rows for each) only make sense once
-- both canonical_wines (0097) and wine_variants (0098) exist.
create table public.wine_aliases (
  id                uuid        primary key default gen_random_uuid(),
  canonical_wine_id uuid        references public.canonical_wines(id) on delete cascade,
  wine_variant_id   uuid        references public.wine_variants(id) on delete cascade,
  restaurant_id     uuid        references public.restaurants(id) on delete cascade,
  raw_producer      text,
  raw_cuvee         text,
  source            text        not null default 'import' check (source in ('import', 'lwin', 'manual')),
  match_method      text        not null check (
    match_method in ('exact', 'lwin_exact', 'fuzzy_suggested', 'fuzzy_confirmed')
  ),
  confidence        real,
  created_at        timestamptz not null default now(),
  -- Exactly one scope per row: canonical-scoped (global, no restaurant_id)
  -- XOR variant-scoped (tenant, restaurant_id required). Never both null,
  -- never both set — a variant-scoped alias without knowing which tenant
  -- asserted it would be an unscoped write nobody could ever read back
  -- under RLS.
  constraint wine_aliases_scope_check check (
    (canonical_wine_id is not null and wine_variant_id is null and restaurant_id is null)
    or (wine_variant_id is not null and restaurant_id is not null)
  )
);

comment on table public.wine_aliases is
  'Append-only spelling/identifier corpus. Canonical-scoped rows '
  '(canonical_wine_id set, restaurant_id null) are the ONLY shape '
  'resolve_wine_variants_bulk below writes in P2 — recording every raw '
  'producer/cuvée string a batch resolved against its canonical_wine_id, '
  'match_method=''exact''. The variant-scoped shape (wine_variant_id + '
  'restaurant_id set) is schema-ready for a future GTIN/LWIN11/LWIN16 '
  'alias writer per docs/plans/2026-08-23-p2-identity-spine.md §8, but no '
  'P2 code path populates it — see the P2 builder report for why that is '
  'flagged as this migration''s weakest point for the merge-completeness '
  'contract test (0100).';

-- Idempotency: resolve_wine_variants_bulk re-run on identical input must
-- add zero new alias rows. Partial (scoped to canonical-only rows) because
-- that is the only shape this migration's writer produces; a future
-- variant-scoped writer needs its own uniqueness rule.
create unique index wine_aliases_canonical_raw_idx
  on public.wine_aliases (canonical_wine_id, raw_producer, raw_cuvee)
  where restaurant_id is null;

create index wine_aliases_variant_idx
  on public.wine_aliases (wine_variant_id)
  where wine_variant_id is not null;

alter table public.wine_aliases enable row level security;

-- Canonical-scoped rows (restaurant_id null) are globally readable, same
-- trust tier as canonical_wines itself; variant-scoped rows are
-- tenant-gated. is_member(null) is false for every caller (no membership
-- row has a null restaurant_id), so this single USING clause correctly
-- implements both halves of docs/plans/2026-08-23-p2-identity-spine.md
-- §8's two-row tenancy table without a second policy.
create policy "read canonical-scoped or own-tenant wine_aliases"
  on public.wine_aliases for select to authenticated
  using (restaurant_id is null or public.is_member(restaurant_id));

-- Shape-restricted, not authenticity-restricted, for the same reason as
-- canonical_wines: match_method may only claim 'exact' (an objectively
-- checkable text-equality fact) or 'fuzzy_suggested' (explicitly
-- non-authoritative). 'lwin_exact'/'fuzzy_confirmed' are reserved for a
-- future privileged writer; nothing in P2 ever inserts them.
create policy "insert canonical-scoped or own-tenant wine_aliases"
  on public.wine_aliases for insert to authenticated
  with check (
    match_method in ('exact', 'fuzzy_suggested')
    and (restaurant_id is null or public.is_member(restaurant_id))
  );

-- No update/delete: append-only ledger.

grant select, insert on table public.wine_aliases to authenticated;

-------------------------------------------------------------------------------
-- resolve_wine_variants_bulk — the dedup service's DB entrypoint.
--
-- Called once per batch of UNIQUE variants (a pre-deduplicated set the
-- caller has already collapsed by (producer_norm, cuvee_norm, vintage,
-- size_ml)), never once per CSV row — the direct answer to C10 (no
-- per-row PL/pgSQL loop, no advisory lock anywhere below).
--
-- SECURITY INVOKER, not definer: this is C01's own fix sketch applied to
-- new code. RLS on wine_variants (is_member(restaurant_id)) is the ONLY
-- thing between a caller and writing another tenant's variant, and
-- invoker mode is what makes that check actually apply. There is
-- deliberately NO manual is_member() guard in this function body — a
-- caller targeting a restaurant_id it is not a member of must fail via
-- the real RLS policy on the wine_variants INSERT below, not a
-- hand-rolled check that could drift from the policy over time.
--
-- Input rows are already normalized by src/domains/identity/normalize.ts
-- — this function does no Unicode folding. lwin7 SHOULD already have
-- cleared the caller's confidence gate (P3's contract: only a
-- lwin_score >= 0.6 match_lwin_bulk result may be forwarded as lwin7;
-- anything weaker is a separate, non-identity-affecting field) — but
-- that contract is a client-side convention, not a server-side
-- guarantee, and this function must not trust it blindly (D9 — scratchpad
-- db-audit/verify/P2-critic-r3.md): a malicious or buggy caller can put
-- ANY 7-digit string in lwin7 regardless of what P3's real code does.
-- The corroboration gate at step 2.5 below is what actually enforces
-- this, by checking the claim against public.lwin_catalog before ever
-- letting it create a canonical_wines row.
create or replace function public.resolve_wine_variants_bulk(
  p_restaurant_id uuid,
  p_variants jsonb
)
returns table (
  idx                    int,
  canonical_wine_id      uuid,
  wine_variant_id        uuid,
  canonical_match_method text,
  canonical_created      boolean,
  variant_created        boolean
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
-- The RETURNS TABLE columns above (canonical_wine_id, wine_variant_id,
-- idx) collide by name with real columns on _rwvb_input/wine_variants/
-- wine_aliases. This function never reads or writes those OUT
-- parameters as PL/pgSQL variables anywhere in its body (only via the
-- final RETURN QUERY, which is alias-qualified and unambiguous) — every
-- bare use of those names elsewhere is meant to resolve to the SQL
-- column, which is what this directive makes happen instead of an
-- "ambiguous" error at the ON CONFLICT target lists below.
begin
  -- Scratch table for this call. "if not exists" + truncate (rather than
  -- a bare CREATE) so a second call within the same transaction — the
  -- fault-injection tests deliberately do this — reuses it safely.
  -- "on commit drop" means it never outlives the calling transaction.
  create temporary table if not exists _rwvb_input (
    idx                    int primary key,
    producer_raw           text not null,
    cuvee_raw              text not null,
    producer_norm          text not null,
    cuvee_norm             text not null,
    vintage                int,
    size_ml                int not null,
    lwin7                  text,
    lwin11                 text,
    lwin16                 text,
    gtin                   text,
    canonical_wine_id      uuid,
    canonical_match_method text,
    canonical_created      boolean not null default false,
    wine_variant_id        uuid,
    variant_created        boolean not null default false
  ) on commit drop;

  truncate _rwvb_input;

  -- 1. Unnest the batch.
  --
  -- P2 ROUND-5 FIX (D9-residual #2 — scratchpad db-audit/verify/
  -- P2-critic-r4.md, the round after the Baron/Lalande fix): this no
  -- longer reads producer_norm/cuvee_norm from the caller at all.
  -- Before this fix, the identity KEY (producer_norm, cuvee_norm — the
  -- columns canonical_wines_identity_idx is UNIQUE on, and what phase 1's
  -- text-match below joins on) came straight off the caller's JSON,
  -- completely UNRELATED to the LWIN-corroboration gate at step 2.5
  -- below, which validates producer_raw/cuvee_raw instead. That let a
  -- caller send REAL, LEGITIMATELY-CORROBORATING raws for a wine they
  -- actually hold (passing the gate) while sending an ARBITRARY,
  -- attacker-chosen producer_norm/cuvee_norm matching a VICTIM's
  -- existing canonical_wines row — binding straight onto it via phase
  -- 1's text-exact match, with no LWIN or gate involvement at all. Live-
  -- reproduced before this fix shipped: an attacker's wine_variant bound
  -- to a victim's pre-existing canonical row via canonical_match_method
  -- = 'exact', using the victim's real (forged-in) producer_norm/
  -- cuvee_norm while submitting the attacker's OWN real, corroborating
  -- producer_raw/cuvee_raw/lwin7. Same severity as the Baron/Lalande
  -- fix above: the unique index makes it permanent, and canonical_wines
  -- has no UPDATE/DELETE policy for authenticated.
  --
  -- Fixed: producer_norm/cuvee_norm are now DERIVED here, server-side,
  -- from producer_raw/cuvee_raw via identity_normalize_text() (0097) —
  -- never trusted as caller input. jsonb_to_recordset's own type list
  -- below no longer even names producer_norm/cuvee_norm, so a caller
  -- that still sends those keys has them silently ignored rather than
  -- silently trusted. This is a CROSS-PIECE CONTRACT CHANGE: the
  -- identity key is no longer necessarily byte-identical to
  -- src/domains/identity/normalize.ts's frozen TS-side
  -- normalizeProducerOrCuvee output — it is now this function's own
  -- SQL-side identity_normalize_text() approximation (see that
  -- function's comment, 0097, for the known unaccent-vs-NFKD divergence
  -- risk, already accepted elsewhere for 0101's backfill). The risk
  -- direction stays safe (a divergence creates one extra canonical row a
  -- later exact match could have reused, never merges two different
  -- wines) — re-verified against the full 110-check identity matrix
  -- after this change specifically because the computation moved from
  -- TS-frozen to SQL-side for every row this function creates.
  insert into _rwvb_input (
    idx, producer_raw, cuvee_raw, producer_norm, cuvee_norm,
    vintage, size_ml, lwin7, lwin11, lwin16, gtin
  )
  select x.idx, x.producer_raw, x.cuvee_raw,
         public.identity_normalize_text(x.producer_raw),
         public.identity_normalize_text(x.cuvee_raw),
         x.vintage, x.size_ml, x.lwin7, x.lwin11, x.lwin16, x.gtin
  from jsonb_to_recordset(p_variants) as x(
    idx int, producer_raw text, cuvee_raw text,
    vintage int, size_ml int, lwin7 text, lwin11 text, lwin16 text, gtin text
  );

  -- Rows whose producer/cuvee collapse to nothing under normalization
  -- (e.g. punctuation-only text) can't be identity-resolved — same
  -- precedent as 0101's backfill, which leaves such rows for manual
  -- review rather than inventing a placeholder identity. P3's caller
  -- must treat a missing idx in the return set as "not resolved," not
  -- assume every submitted idx comes back.
  delete from _rwvb_input
  where producer_norm is null or cuvee_norm is null;

  -- 2. Canonical, phase 1 (exact). Two separate UPDATEs, not one OR'd
  -- join, so LWIN7 equality deterministically wins even where producer/
  -- cuvée text differs (a data-entry-error row still lands on the LWIN
  -- identity, never forks a second canonical row for it — it becomes an
  -- alias below, not a duplicate).
  --
  -- P2 ROUND-5 FIX (D9-residual — scratchpad db-audit/verify/
  -- P2-critic-r4.md): this match now additionally requires
  -- cw.identity_status = 'lwin_verified'. Before this fix, a row could
  -- squat a real lwin7 as identity_status='unverified' — the round-4
  -- corroboration gate below only ran for the 'lwin_verified' branch of
  -- canonical_wines' own insert policy, and this match had NO
  -- identity_status filter, so it matched ANY row carrying that lwin7,
  -- verified or not. Combined with canonical_wines_lwin7_idx being
  -- UNIQUE, that meant: squat lwin7 X as unverified garbage (the
  -- corroboration check was never consulted, because it only gated the
  -- lwin_verified path) -> nobody else can ever hold X -> every later
  -- import carrying X, INCLUDING a fully legitimate, fully corroborated
  -- one, matched the squatter right here, before any gate ran. No
  -- attacker cleverness or fuzzy-threshold weakness was even needed for
  -- that path. Fixed at two levels: 0097's new
  -- canonical_wines_lwin7_requires_verified CHECK CONSTRAINT now makes
  -- "unverified row with a non-null lwin7" impossible to insert AT ALL,
  -- from any path, including this function and 0101's backfill; this
  -- explicit filter is defense-in-depth on top of that invariant, so the
  -- match's OWN correctness never silently depends on a constraint
  -- defined elsewhere.
  update _rwvb_input i
  set canonical_wine_id = cw.id,
      canonical_match_method = 'lwin_exact'
  from public.canonical_wines cw
  where i.lwin7 is not null
    and cw.lwin7 = i.lwin7
    and cw.identity_status = 'lwin_verified';

  update _rwvb_input i
  set canonical_wine_id = cw.id,
      canonical_match_method = 'exact'
  from public.canonical_wines cw
  where i.canonical_wine_id is null
    and cw.producer_norm = i.producer_norm
    and cw.cuvee_norm = i.cuvee_norm;

  -- 2.5. LWIN corroboration gate. A row that reaches here has NOT matched
  -- any existing canonical_wines row (neither by verified LWIN equality
  -- nor by exact text) and is about to CREATE one in phase 2 below,
  -- claiming identity_status='lwin_verified' whenever its lwin7 is set.
  -- lwin7 is caller-supplied, untrusted input — this is the only thing
  -- standing between an arbitrary claim and a permanent, cross-tenant,
  -- unrepairable global identity (canonical_wines has no UPDATE/DELETE
  -- policy; canonical_wines_lwin7_idx is UNIQUE).
  --
  -- P2 ROUND-5 FIX (D9-residual — scratchpad db-audit/verify/
  -- P2-critic-r4.md): round 4 gated this with pg_trgm similarity() at
  -- match_lwin's own ranking thresholds (0.3 producer / 0.21 name) —
  -- WRONG TOOL. match_lwin's threshold is deliberately tolerant of false
  -- positives because a human reviews its suggestions before anything is
  -- written; this gate makes a PERMANENT, UNSUPERVISED, cross-tenant
  -- decision. Live-verified before this fix shipped:
  -- similarity('Chateau Pichon Longueville Baron', 'Chateau Pichon
  -- Longueville Comtesse de Lalande') = 0.55 — two REAL, DISTINCT
  -- Bordeaux estates, both comfortably above 0.3, because they share a
  -- long common prefix. The round-5 critic reproduced the full
  -- cross-tenant hijack through this exact pair using nothing but the
  -- system's own real data: tenant A's fully legitimate, correctly-typed
  -- Lalande submission plus Baron's real lwin7 (a plausible C24-style
  -- LWIN-matcher confusion, not an adversarial construction) passed this
  -- gate; tenant B's later, equally legitimate Baron submission with the
  -- same lwin7 then bound to tenant A's Lalande-labelled row via phase 1
  -- above, by design. No fuzzy threshold reliably separates two wines
  -- whose similarity comes from shared vocabulary rather than shared
  -- identity.
  --
  -- Fixed: identity_normalize_text() (0097) applied to both sides.
  -- PRODUCER is compared for EXACT equality — Baron and Lalande normalize
  -- to different token sets and can never satisfy equality regardless of
  -- shared words, while a genuine data-entry-error (accents/case/
  -- spacing/punctuation) still normalizes identically on both sides. CUVEE
  -- is compared by TOKEN SUBSET (submitted cuvee's tokens all present in
  -- display_name's tokens), not exact equality, since lwin_catalog.
  -- display_name commonly combines producer + wine name — see 0097's
  -- policy comment for the full reasoning. Both are deterministic
  -- set/string operations, never a score — preserving the "LWIN wins over
  -- textual FORMATTING differences" behavior described above for its
  -- actual intended case.
  -- A row whose lwin7 fails corroboration is DOWNGRADED (lwin7 stripped,
  -- so phase 2 below naturally falls to identity_status='unverified'),
  -- not rejected: a single bad LWIN in a 5,000-row import chunk must not
  -- abort the whole chunk, and this row still gets a real (unverified)
  -- canonical identity via its own text. Set-based, no per-row loop, no
  -- exception raised — the direct C10-consistent answer, same discipline
  -- as every other step in this function. The phase-1 exact-match above
  -- is unaffected and remains safe by construction: it only ever matches
  -- EXISTING, ALREADY-VERIFIED canonical_wines rows (identity_status
  -- filter, this fix), and every verified row was itself either created
  -- through this same deterministic gate or through 0101's backfill
  -- (which reuses identity_normalize_text() directly rather than
  -- duplicating the expression — see that migration's header for why it
  -- still needs its own copy of the CALL: it runs as the table owner and
  -- bypasses RLS entirely, so canonical_wines' own INSERT policy
  -- corroboration cannot protect it; only the CHECK CONSTRAINT does).
  -- P2 ROUND-6 FIX (D9-residual #2): this gate now reads i.producer_norm/
  -- i.cuvee_norm — the very values phase 2 goes on to store — instead of
  -- recomputing identity_normalize_text(i.producer_raw) inline. The two
  -- are equal by construction (step 1 derives the norm columns with that
  -- exact call), so this changes no outcome today; it changes what a
  -- future edit can break. The whole D9-residual bug class is "the value
  -- checked and the value stored are different expressions that nobody
  -- forces to agree," and re-deriving here left one more copy of that
  -- shape in the file. Reading the stored column makes the gate and the
  -- identity key the same value rather than two values that happen to
  -- match.
  update _rwvb_input i
  set lwin7 = null
  where i.canonical_wine_id is null
    and i.lwin7 is not null
    and not exists (
      select 1 from public.lwin_catalog lc
      where lc.lwin_id = i.lwin7
        and i.producer_norm = public.identity_normalize_text(lc.producer)
        and string_to_array(i.cuvee_norm, ' ') <@ string_to_array(public.identity_normalize_text(lc.display_name), ' ')
    );

  -- 3. Canonical, phase 2 (create). DISTINCT ON collapses two rows in the
  -- SAME batch that are the same new wine to one insert attempt — the
  -- direct answer to the "same-batch duplicate" fault injection.
  -- ON CONFLICT DO NOTHING handles a genuinely concurrent OTHER call
  -- committing the same (producer_norm, cuvee_norm) between step 2 and
  -- here.
  -- P2 ROUND-6 (D9-residual #2): producer_norm/cuvee_norm are no longer
  -- named in this insert — canonical_wines GENERATES them from producer/
  -- cuvee (0097), and naming a generated column raises SQLSTATE 428C9.
  -- The stored key is therefore identity_normalize_text(i.producer_raw),
  -- byte-identical to the i.producer_norm this statement still uses for
  -- DISTINCT ON and for the conflict target, because step 1 derived that
  -- column with the same call.
  with new_canon as (
    insert into public.canonical_wines (
      producer, cuvee, lwin7,
      identity_status, created_by_restaurant_id, created_by_user_id
    )
    select distinct on (i.producer_norm, i.cuvee_norm)
      i.producer_raw, i.cuvee_raw, i.lwin7,
      case when i.lwin7 is not null then 'lwin_verified' else 'unverified' end,
      p_restaurant_id, auth.uid()
    from _rwvb_input i
    where i.canonical_wine_id is null
    order by i.producer_norm, i.cuvee_norm, i.idx
    on conflict (producer_norm, cuvee_norm) do nothing
    returning id, producer_norm, cuvee_norm
  )
  update _rwvb_input i
  set canonical_wine_id = nc.id,
      canonical_match_method = 'created',
      canonical_created = true
  from new_canon nc
  where i.canonical_wine_id is null
    and i.producer_norm = nc.producer_norm
    and i.cuvee_norm = nc.cuvee_norm;

  -- 4. Re-join: lost-the-conflict-race read-back. Under READ COMMITTED,
  -- this SELECT gets a fresh snapshot and will see a concurrent session's
  -- now-committed insert.
  update _rwvb_input i
  set canonical_wine_id = cw.id,
      canonical_match_method = 'exact',
      canonical_created = false
  from public.canonical_wines cw
  where i.canonical_wine_id is null
    and cw.producer_norm = i.producer_norm
    and cw.cuvee_norm = i.cuvee_norm;

  -- 5. Variant resolution — identical two-phase pattern keyed on
  -- (restaurant_id, canonical_wine_id, coalesce(vintage,0), size_ml).
  -- vintage and size_ml are exact keys here, never fuzzy — see the
  -- migration header.
  update _rwvb_input i
  set wine_variant_id = wv.id
  from public.wine_variants wv
  where wv.restaurant_id = p_restaurant_id
    and wv.canonical_wine_id = i.canonical_wine_id
    and coalesce(wv.vintage, 0) = coalesce(i.vintage, 0)
    and wv.size_ml = i.size_ml;

  with new_variants as (
    insert into public.wine_variants (
      restaurant_id, canonical_wine_id, vintage, size_ml, lwin11, lwin16, gtin
    )
    select distinct on (i.canonical_wine_id, coalesce(i.vintage, 0), i.size_ml)
      p_restaurant_id, i.canonical_wine_id, i.vintage, i.size_ml, i.lwin11, i.lwin16, i.gtin
    from _rwvb_input i
    where i.wine_variant_id is null
    order by i.canonical_wine_id, coalesce(i.vintage, 0), i.size_ml, i.idx
    on conflict (restaurant_id, canonical_wine_id, coalesce(vintage, 0), size_ml) do nothing
    returning id, canonical_wine_id, vintage, size_ml
  )
  update _rwvb_input i
  set wine_variant_id = nv.id,
      variant_created = true
  from new_variants nv
  where i.wine_variant_id is null
    and i.canonical_wine_id = nv.canonical_wine_id
    and coalesce(i.vintage, 0) = coalesce(nv.vintage, 0)
    and i.size_ml = nv.size_ml;

  update _rwvb_input i
  set wine_variant_id = wv.id
  from public.wine_variants wv
  where i.wine_variant_id is null
    and wv.restaurant_id = p_restaurant_id
    and wv.canonical_wine_id = i.canonical_wine_id
    and coalesce(wv.vintage, 0) = coalesce(i.vintage, 0)
    and wv.size_ml = i.size_ml;

  -- 6. Alias write — the spelling corpus. One batched, deduped insert;
  -- ON CONFLICT DO NOTHING against wine_aliases_canonical_raw_idx is what
  -- makes a re-run of identical input add zero new rows here too.
  insert into public.wine_aliases (canonical_wine_id, raw_producer, raw_cuvee, source, match_method)
  select distinct on (i.canonical_wine_id, i.producer_raw, i.cuvee_raw)
    i.canonical_wine_id, i.producer_raw, i.cuvee_raw, 'import', 'exact'
  from _rwvb_input i
  where i.canonical_wine_id is not null
  order by i.canonical_wine_id, i.producer_raw, i.cuvee_raw, i.idx
  on conflict (canonical_wine_id, raw_producer, raw_cuvee) where restaurant_id is null do nothing;

  -- 7. Return the per-idx result set.
  return query
  select i.idx, i.canonical_wine_id, i.wine_variant_id, i.canonical_match_method,
         i.canonical_created, i.variant_created
  from _rwvb_input i
  order by i.idx;
end;
$$;

comment on function public.resolve_wine_variants_bulk(uuid, jsonb) is
  'Set-based identity resolution for a pre-deduplicated batch of unique '
  '(producer, cuvee, vintage, size_ml) variants. SECURITY INVOKER: RLS on '
  'wine_variants is the tenant boundary, not a check in this function. '
  'Every phase is a fixed number of set-based statements regardless of '
  'batch size — no per-row loop, no advisory lock.';

revoke all on function public.resolve_wine_variants_bulk(uuid, jsonb) from public;
grant execute on function public.resolve_wine_variants_bulk(uuid, jsonb) to authenticated;

-- === 0100_wine_identity_merge.sql ===
-- 0100_wine_identity_merge.sql
-- P2 — wine identity spine, part 4: merge, closing the confirmed C23 gap.
--
-- identity_merge_log is an append-only forensic record of every merge.
-- Merges are hard deletes, not self-service-reversible — this table gives
-- a human enough (a full snapshot of the deleted row, plus per-child moved
-- counts) to reconstruct one by hand if it was a mistake. There is no
-- unmerge_* RPC in P2.
create table public.identity_merge_log (
  id              uuid        primary key default gen_random_uuid(),
  merge_type      text        not null check (merge_type in ('canonical_wine', 'wine')),
  source_id       uuid        not null,
  target_id       uuid        not null,
  restaurant_id   uuid        references public.restaurants(id) on delete set null,
  source_snapshot jsonb       not null,
  moved_counts    jsonb       not null,
  merged_by       uuid        references auth.users(id) on delete set null,
  merged_at       timestamptz not null default now()
);

comment on table public.identity_merge_log is
  'Append-only. restaurant_id is populated for wine-level merges '
  '(merge_wines), null for canonical-level merges (merge_canonical_wines), '
  'since a canonical merge is inherently cross-tenant. Written only by '
  'those two functions, both SECURITY DEFINER/service-role, never by a '
  'raw client insert.';

create index identity_merge_log_restaurant_idx
  on public.identity_merge_log (restaurant_id, merged_at desc)
  where restaurant_id is not null;
create index identity_merge_log_source_idx on public.identity_merge_log (source_id);
create index identity_merge_log_target_idx on public.identity_merge_log (target_id);

alter table public.identity_merge_log enable row level security;

-- is_member(null) is false for every caller, so this single policy
-- correctly hides every canonical-level (restaurant_id null) row from
-- authenticated clients — those are readable only by service_role, which
-- bypasses RLS entirely (confirmed: service_role has BYPASSRLS locally).
create policy "members can read their restaurant's merge log"
  on public.identity_merge_log for select to authenticated
  using (public.is_member(restaurant_id));

-- No insert/update/delete policy for authenticated/anon: merge_wines is
-- SECURITY DEFINER (runs as its owner regardless of grants) and
-- merge_canonical_wines is service-role-only, so neither needs a client
-- write grant here.
grant select on table public.identity_merge_log to authenticated;

-------------------------------------------------------------------------------
-- merge_wines — replaced again (the same pattern 0055 used on 0054's
-- version). Extended per the confirmed C23 finding
-- (scratchpad db-audit/verify/V4-bottles.md): the shipped function
-- repointed only 5 of the 10 live FKs to wines(id), and 4 of the other 5
-- were CASCADE — silently destroyed, not orphaned, under a 200 OK that
-- never mentioned the loss. All 10 confirmed via a live pg_constraint
-- query against this exact schema (see the P2 builder report). Existing
-- lineage/vintage/format-equality guards and the manager-role check are
-- untouched — this is a mechanical extension, not a rewrite of its
-- guards.
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
  v_source                    public.wines%rowtype;
  v_target                    public.wines%rowtype;
  v_restaurant_id              uuid;
  v_moved_inventory            int;
  v_moved_pours                int;
  v_moved_bottles              int;
  v_moved_list_items           int;
  v_deduped_list_items         int;
  v_moved_avail                int;
  v_moved_bottle_closeouts     int;
  v_moved_stock_adjustments    int;
  v_moved_pricing_recs         int;
  v_moved_cellar_health        int;
  v_dropped_cellar_health      int;
  v_moved_import_batch_rows    int;
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

  -- P2: wine_variant_id repoint, fail loud rather than silently pick.
  -- Both set and different means normalization failed to converge two
  -- spellings onto one identity — the fix is a merge_canonical_wines call
  -- first, not this function guessing which one is right.
  if v_source.wine_variant_id is not null and v_target.wine_variant_id is not null
     and v_source.wine_variant_id <> v_target.wine_variant_id then
    raise exception 'variant_identity_conflict: source wine_variant_id % and target wine_variant_id % disagree — run merge_canonical_wines to reconcile the underlying identities first',
      v_source.wine_variant_id, v_target.wine_variant_id;
  end if;

  if v_target.wine_variant_id is null and v_source.wine_variant_id is not null then
    update public.wines set wine_variant_id = v_source.wine_variant_id
     where id = p_target_wine_id;
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

  -- P2 (C23 fix): bottle_closeouts, stock_adjustments, pricing_recommendations
  -- have no uniqueness constraint blocking a blind repoint — real write-offs,
  -- comps, and pricing history that a pre-P2 merge silently cascade-deleted.
  update public.bottle_closeouts set wine_id = p_target_wine_id
   where wine_id = p_source_wine_id;
  get diagnostics v_moved_bottle_closeouts = row_count;

  update public.stock_adjustments set wine_id = p_target_wine_id
   where wine_id = p_source_wine_id;
  get diagnostics v_moved_stock_adjustments = row_count;

  update public.pricing_recommendations set wine_id = p_target_wine_id
   where wine_id = p_source_wine_id;
  get diagnostics v_moved_pricing_recs = row_count;

  -- cellar_health has unique(restaurant_id, wine_id); since source and
  -- target share one restaurant (enforced above), at most one row per
  -- wine can exist. If the target already has one, the source's is a
  -- redundant duplicate (recomputed nightly, per its own migration
  -- comment) — drop it rather than picking one arbitrarily. Otherwise
  -- repoint it.
  delete from public.cellar_health s
   where s.wine_id = p_source_wine_id
     and exists (
           select 1 from public.cellar_health t
            where t.wine_id = p_target_wine_id and t.restaurant_id = s.restaurant_id
         );
  get diagnostics v_dropped_cellar_health = row_count;

  update public.cellar_health set wine_id = p_target_wine_id
   where wine_id = p_source_wine_id;
  get diagnostics v_moved_cellar_health = row_count;

  -- P2 (C23 fix): import_batch_rows.applied_wine_id is ON DELETE SET NULL
  -- today — the merge silently orphans "which import created this wine".
  update public.import_batch_rows set applied_wine_id = p_target_wine_id
   where applied_wine_id = p_source_wine_id;
  get diagnostics v_moved_import_batch_rows = row_count;

  insert into public.identity_merge_log (
    merge_type, source_id, target_id, restaurant_id, source_snapshot, moved_counts, merged_by
  ) values (
    'wine', p_source_wine_id, p_target_wine_id, v_restaurant_id,
    to_jsonb(v_source),
    jsonb_build_object(
      'moved_inventory_items',      v_moved_inventory,
      'moved_pour_events',          v_moved_pours,
      'moved_open_bottles',         v_moved_bottles,
      'moved_wine_list_items',      v_moved_list_items,
      'deduped_wine_list_items',    v_deduped_list_items,
      'moved_availability_events',  v_moved_avail,
      'moved_bottle_closeouts',     v_moved_bottle_closeouts,
      'moved_stock_adjustments',    v_moved_stock_adjustments,
      'moved_pricing_recommendations', v_moved_pricing_recs,
      'moved_cellar_health',        v_moved_cellar_health,
      'dropped_cellar_health',      v_dropped_cellar_health,
      'moved_import_batch_rows',    v_moved_import_batch_rows
    ),
    auth.uid()
  );

  delete from public.wines where id = p_source_wine_id;

  return jsonb_build_object(
    'target_id',                     p_target_wine_id,
    'moved_inventory_items',         v_moved_inventory,
    'moved_pour_events',             v_moved_pours,
    'moved_open_bottles',            v_moved_bottles,
    'moved_wine_list_items',         v_moved_list_items,
    'deduped_wine_list_items',       v_deduped_list_items,
    'moved_availability_events',     v_moved_avail,
    'moved_bottle_closeouts',        v_moved_bottle_closeouts,
    'moved_stock_adjustments',       v_moved_stock_adjustments,
    'moved_pricing_recommendations', v_moved_pricing_recs,
    'moved_cellar_health',           v_moved_cellar_health,
    'dropped_cellar_health',         v_dropped_cellar_health,
    'moved_import_batch_rows',       v_moved_import_batch_rows
  );
end;
$$;

comment on function public.merge_wines(uuid, uuid) is
  'P2 extension (0100) of the 0055 version: now repoints all 10 live FKs '
  'to wines(id) (previously 5), closing the confirmed C23 data-loss gap, '
  'plus the new wine_variant_id conflict guard. See '
  'supabase/tests/0100_merge_completeness.sql for the standing regression '
  'test that fails the build if a future FK to wines/canonical_wines/'
  'wine_variants is added without updating this function or '
  'merge_canonical_wines.';

-------------------------------------------------------------------------------
-- merge_canonical_wines — operator/service-role only. NOT exposed to
-- tenants: the orchestrating session narrowed this from the plan's
-- original "any manager at one stakeholder restaurant" design (the
-- plan's own §14 flagged that authorization rule as its least-settled
-- decision) rather than inventing an untested cross-tenant permissions
-- model. Tenant-level deduplication is fully served by merge_wines above;
-- this function exists so an operator can fix the shared canonical
-- catalog itself (e.g. two independently-created rows for the same
-- real-world wine because two tenants imported it before either had a
-- matching LWIN).
--
-- SECURITY INVOKER, not definer (a deliberate deviation from the plan's
-- text): the plan called for DEFINER because it originally needed to let
-- an ordinary authenticated tenant manager cross a tenancy boundary they
-- couldn't otherwise see. Now that only service_role may call this
-- function at all (see the grant below), DEFINER's privilege elevation is
-- not load-bearing — service_role already has BYPASSRLS (confirmed
-- locally: rolbypassrls=true), so INVOKER reaches every row this function
-- needs without any elevation, at strictly lower privilege. There is no
-- manager-role check in this body for the same reason: the grant IS the
-- authorization.
-------------------------------------------------------------------------------
create or replace function public.merge_canonical_wines(
  p_source_id uuid,
  p_target_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_source              public.canonical_wines%rowtype;
  v_target              public.canonical_wines%rowtype;
  v_conflict_restaurant uuid;
  v_conflict_vintage    int;
  v_conflict_size_ml    int;
  v_moved_variants      int;
  v_moved_lineages      int;
  v_moved_wines         int;
  v_moved_aliases       int;
  v_deduped_aliases     int;
begin
  if p_source_id = p_target_id then
    raise exception 'identical_merge: source and target are the same canonical wine';
  end if;

  perform 1 from public.canonical_wines
    where id in (p_source_id, p_target_id)
    order by id
    for update;

  select * into v_source from public.canonical_wines where id = p_source_id;
  select * into v_target from public.canonical_wines where id = p_target_id;

  if v_source.id is null or v_target.id is null then
    raise exception 'canonical_wine_not_found: both canonical wines must exist';
  end if;

  -- variant_conflict: a restaurant holding both source and target as the
  -- same (vintage, size_ml) is a real tenant-level duplicate this merge
  -- would otherwise create by repointing both onto one canonical id.
  -- Fail loud and name the restaurant — resolved via that tenant's own
  -- merge_wines first, deliberately not auto-resolved here.
  select a.restaurant_id, a.vintage, a.size_ml
    into v_conflict_restaurant, v_conflict_vintage, v_conflict_size_ml
  from public.wine_variants a
  where a.canonical_wine_id = p_source_id
    and exists (
      select 1 from public.wine_variants b
      where b.canonical_wine_id = p_target_id
        and b.restaurant_id = a.restaurant_id
        and coalesce(b.vintage, 0) = coalesce(a.vintage, 0)
        and b.size_ml = a.size_ml
    )
  limit 1;

  if v_conflict_restaurant is not null then
    raise exception 'variant_conflict: restaurant % already holds both canonical wines as the same vintage (%) and size_ml (%) — resolve via that restaurant''s merge_wines first',
      v_conflict_restaurant, coalesce(v_conflict_vintage::text, 'NV'), v_conflict_size_ml;
  end if;

  update public.wine_variants set canonical_wine_id = p_target_id
   where canonical_wine_id = p_source_id;
  get diagnostics v_moved_variants = row_count;

  update public.wine_lineages set canonical_wine_id = p_target_id
   where canonical_wine_id = p_source_id;
  get diagnostics v_moved_lineages = row_count;

  -- wines.canonical_wine_id is denormalized off wine_variants (see 0098's
  -- wines_derive_canonical_wine_id trigger) but that trigger only fires on
  -- wines.wine_variant_id changing — not on the wine_variants row it
  -- points at being repointed underneath it by this function. Without
  -- this line the denormalized column would silently go stale the moment
  -- this function runs, which is exactly the kind of convention-only
  -- invariant 0098's own comment says C17 already showed is unsafe.
  update public.wines set canonical_wine_id = p_target_id
   where canonical_wine_id = p_source_id;
  get diagnostics v_moved_wines = row_count;

  -- Dedup exact-duplicate aliases before repointing, mirroring 0055's
  -- wine_list_items dedupe: a raw string already recorded against the
  -- target keeps only one row.
  delete from public.wine_aliases s
   where s.canonical_wine_id = p_source_id
     and exists (
       select 1 from public.wine_aliases t
        where t.canonical_wine_id = p_target_id
          and t.raw_producer is not distinct from s.raw_producer
          and t.raw_cuvee is not distinct from s.raw_cuvee
     );
  get diagnostics v_deduped_aliases = row_count;

  update public.wine_aliases set canonical_wine_id = p_target_id
   where canonical_wine_id = p_source_id;
  get diagnostics v_moved_aliases = row_count;

  insert into public.identity_merge_log (
    merge_type, source_id, target_id, restaurant_id, source_snapshot, moved_counts, merged_by
  ) values (
    'canonical_wine', p_source_id, p_target_id, null,
    to_jsonb(v_source),
    jsonb_build_object(
      'moved_wine_variants', v_moved_variants,
      'moved_wine_lineages', v_moved_lineages,
      'moved_wines',         v_moved_wines,
      'moved_wine_aliases',  v_moved_aliases,
      'deduped_wine_aliases', v_deduped_aliases
    ),
    auth.uid()
  );

  delete from public.canonical_wines where id = p_source_id;

  return jsonb_build_object(
    'target_id',            p_target_id,
    'moved_wine_variants',  v_moved_variants,
    'moved_wine_lineages',  v_moved_lineages,
    'moved_wines',          v_moved_wines,
    'moved_wine_aliases',   v_moved_aliases,
    'deduped_wine_aliases', v_deduped_aliases
  );
end;
$$;

comment on function public.merge_canonical_wines(uuid, uuid) is
  'Operator/service-role only — see the comment above this function''s '
  'definition for why there is no authenticated grant and no in-body '
  'role check. Every future migration adding an FK to canonical_wines(id)'
  '/wine_variants(id) MUST extend this function (or merge_wines) AND '
  'supabase/tests/0100_merge_completeness.sql in the same migration.';

revoke all on function public.merge_canonical_wines(uuid, uuid) from public;
grant execute on function public.merge_canonical_wines(uuid, uuid) to service_role;

-- === 0101_wine_identity_backfill.sql ===
-- 0101_wine_identity_backfill.sql
-- P2 — wine identity spine, part 5: data migration for pre-existing wines
-- rows. Idempotent (every pass is scoped to "where wine_variant_id is
-- null"), following the three-pass structure 0054_wine_lineages.sql
-- already used for its own backfill.
--
-- Normalization here is public.identity_normalize_text() (0097) — the
-- same function that GENERATES canonical_wines' identity key, so this
-- pass cannot key a row differently from any other writer even though it
-- runs as the table owner with RLS bypassed.
--
-- P2 ROUND-6 CORRECTION, recorded rather than quietly fixed: this header
-- previously called the SQL normalization a "best-effort approximation"
-- of src/domains/identity/normalize.ts and argued the divergence was
-- acceptable because its failure mode is always "creates one extra
-- canonical/variant row a later exact match could have reused," never
-- "merges two different wines." That argument was sound only while the
-- SQL side merely COMPARED. Once round 5 moved identity-key derivation
-- server-side, the same divergence became capable of merging two
-- different wines, and it immediately did: the SQL function lacked
-- normalize.ts's possessive-suffix rule, so "O'Brien's Vineyard" and
-- "O.S. Brien Vineyard" — the exact D3 pair round 2 separated — both
-- normalized to "brien o s vineyard" and would have shared one canonical
-- identity. Measured, not theorised: 10 of 17 frozen golden vectors
-- agreed before the fix, 17 of 17 after. The two implementations are now
-- asserted equivalent unconditionally by
-- src/domains/identity/normalize.test.ts rather than assumed close
-- enough, and the "never merges two different wines" guarantee is
-- restored by that test rather than by argument.
--
-- On a fresh local stack `wines` is empty, so this is a no-op there; it
-- exists for production-safety discipline, matching this codebase's habit
-- of never assuming a clean slate.
--
-- Uses explicit `drop table if exists` cleanup rather than
-- `on commit drop`: unlike resolve_wine_variants_bulk (0099), which
-- creates its scratch table inside one plpgsql function call and is
-- therefore guaranteed to run within a single transaction regardless of
-- caller behavior, this is a top-level migration file whose transaction
-- boundaries are the migration runner's to decide — explicit drops make
-- cleanup correct either way.
create extension if not exists unaccent;

drop table if exists _identity_backfill_norm;
create temporary table _identity_backfill_norm as
select
  w.id as wine_id,
  w.restaurant_id,
  w.producer,
  w.name,
  w.vintage,
  w.size_ml,
  -- P2 ROUND-5 (D9-residual — scratchpad db-audit/verify/P2-critic-r4.md):
  -- reuses public.identity_normalize_text() (0097) instead of duplicating
  -- this exact expression inline — it now also backs the LWIN
  -- corroboration gate below, and one implementation is easier to keep
  -- correct than several copies that "agree on the same bug because they
  -- hardcode the same literals" (the round-4 critic's framing of why
  -- three independent copies of the OLD fuzzy check weren't actually
  -- independent verification).
  public.identity_normalize_text(w.producer) as producer_norm,
  public.identity_normalize_text(w.name) as cuvee_norm,
  case when w.lwin_id ~ '^[0-9]{7}' then substr(w.lwin_id, 1, 7) else null end as lwin7
from public.wines w
where w.wine_variant_id is null;

-- Rows whose producer/name collapse to nothing under normalization (e.g.
-- punctuation-only text) can't be identity-resolved by this pass — leave
-- them for manual review rather than inventing a placeholder identity.
delete from _identity_backfill_norm
where producer_norm is null or cuvee_norm is null;

-------------------------------------------------------------------------------
-- Pass B: canonical_wines — two-phase exact-key match/create, same shape
-- as resolve_wine_variants_bulk (0099): LWIN7 wins over text, DISTINCT ON
-- collapses same-batch duplicates, ON CONFLICT DO NOTHING handles a
-- concurrent writer.
-------------------------------------------------------------------------------
drop table if exists _identity_backfill_resolved;
create temporary table _identity_backfill_resolved (
  wine_id           uuid primary key,
  canonical_wine_id uuid not null,
  restaurant_id     uuid not null,
  vintage           int,
  size_ml           int not null
);

-- P2 ROUND-5 FIX (D9-residual): identity_status = 'lwin_verified' added.
-- Without it, this join would match ANY canonical_wines row carrying
-- n.lwin7 regardless of whether it was ever corroborated — the same
-- "unverified-squat" hole closed on the resolve_wine_variants_bulk path
-- (0099) and now also closed here, plus universally by 0097's
-- canonical_wines_lwin7_requires_verified CHECK CONSTRAINT (this filter
-- is defense-in-depth on top of that invariant).
insert into _identity_backfill_resolved (wine_id, canonical_wine_id, restaurant_id, vintage, size_ml)
select n.wine_id, cw.id, n.restaurant_id, n.vintage, n.size_ml
from _identity_backfill_norm n
join public.canonical_wines cw
  on n.lwin7 is not null and cw.lwin7 = n.lwin7 and cw.identity_status = 'lwin_verified';

insert into _identity_backfill_resolved (wine_id, canonical_wine_id, restaurant_id, vintage, size_ml)
select n.wine_id, cw.id, n.restaurant_id, n.vintage, n.size_ml
from _identity_backfill_norm n
join public.canonical_wines cw
  on cw.producer_norm = n.producer_norm and cw.cuvee_norm = n.cuvee_norm
where n.wine_id not in (select wine_id from _identity_backfill_resolved);

-- P2 ROUND-4/5 HISTORY (D9, then D9-residual — scratchpad
-- db-audit/verify/P2-critic-r3.md and -r4.md): every row still
-- unresolved at this point is about to CREATE a canonical_wines row
-- below, claiming identity_status='lwin_verified' whenever its lwin7 is
-- set. This migration runs as the table owner and BYPASSES RLS entirely
-- — 0097's insert-policy corroboration cannot reach it, and (before
-- round 5) neither could 0097's CHECK CONSTRAINT, since it didn't exist
-- yet — so this backfill needs its own copy of the corroboration LOGIC
-- regardless (0097's canonical_wines_lwin7_requires_verified CHECK
-- CONSTRAINT now backstops the OUTCOME universally, but this UPDATE is
-- what makes the CREATE decision correct in the first place, not merely
-- constraint-safe). wines.lwin_id is itself settable by any tenant
-- member via a plain UPDATE on wines with no catalog validation (the
-- wines update policy is is_member(restaurant_id) with no column
-- restriction), so this is the same forgery/mis-binding vector as the
-- resolve_wine_variants_bulk path, triggered by a one-time migration over
-- whatever wines rows exist at deploy time rather than a live RPC call.
--
-- Round 4 gated this with pg_trgm similarity() at match_lwin's own
-- ranking thresholds (0.3/0.21) — the wrong tool for a permanent,
-- unsupervised decision: similarity('Chateau Pichon Longueville Baron',
-- 'Chateau Pichon Longueville Comtesse de Lalande') = 0.55, comfortably
-- above 0.3, for two REAL, DISTINCT estates. Round 5 replaces it with
-- identity_normalize_text() (see 0097's definition and the corresponding
-- fix in 0099 for the full Baron/Lalande write-up): EXACT equality on
-- producer, TOKEN SUBSET on cuvee (display_name commonly combines
-- producer + wine name, so exact-string cuvee matching would reject
-- every legitimate case) — both deterministic, neither a score, so this
-- separates genuinely different producers while still tolerating
-- accent/case/spacing/punctuation-only differences. A
-- row that fails corroboration is downgraded (lwin7 stripped) to
-- identity_status='unverified' below, not dropped from the backfill
-- entirely — it still gets a real identity via its own text, matching
-- this file's own already-documented risk tolerance ("creates one extra
-- canonical/variant row a later exact match could have reused," never
-- "merges two different wines").
-- P2 ROUND-6 FIX (D9-residual #2): reads n.producer_norm/n.cuvee_norm —
-- the values this pass actually resolves and stores on — rather than
-- recomputing the normalization inline, for the same reason 0099's gate
-- does. Equal by construction (both come from identity_normalize_text
-- over the same source text), so no outcome changes; what changes is
-- that a later edit can no longer make the checked value and the keyed
-- value drift apart, which is the entire D9-residual bug class.
update _identity_backfill_norm n
set lwin7 = null
where n.wine_id not in (select wine_id from _identity_backfill_resolved)
  and n.lwin7 is not null
  and not exists (
    select 1 from public.lwin_catalog lc
    where lc.lwin_id = n.lwin7
      and n.producer_norm = public.identity_normalize_text(lc.producer)
      and string_to_array(n.cuvee_norm, ' ') <@ string_to_array(public.identity_normalize_text(lc.display_name), ' ')
  );

-- P2 ROUND-6 (D9-residual #2): producer_norm/cuvee_norm are omitted —
-- canonical_wines GENERATES them (0097). This migration runs as the
-- table owner and bypasses RLS, so before round 6 it was the one path
-- that could write ANY identity key with no policy in its way; the
-- generated columns now bind it to n.producer/n.name exactly like every
-- other caller. The stored key stays byte-identical to the
-- n.producer_norm this statement still uses for DISTINCT ON and as the
-- conflict target, since _identity_backfill_norm derived it with the
-- same function call.
with new_canon as (
  insert into public.canonical_wines (
    producer, cuvee, lwin7, identity_status,
    created_by_restaurant_id
  )
  select distinct on (n.producer_norm, n.cuvee_norm)
    n.producer, n.name, n.lwin7,
    case when n.lwin7 is not null then 'lwin_verified' else 'unverified' end,
    n.restaurant_id
  from _identity_backfill_norm n
  where n.wine_id not in (select wine_id from _identity_backfill_resolved)
  order by n.producer_norm, n.cuvee_norm, n.wine_id
  on conflict (producer_norm, cuvee_norm) do nothing
  returning id, producer_norm, cuvee_norm
)
insert into _identity_backfill_resolved (wine_id, canonical_wine_id, restaurant_id, vintage, size_ml)
select n.wine_id, nc.id, n.restaurant_id, n.vintage, n.size_ml
from _identity_backfill_norm n
join new_canon nc on nc.producer_norm = n.producer_norm and nc.cuvee_norm = n.cuvee_norm
where n.wine_id not in (select wine_id from _identity_backfill_resolved);

-- Lost-the-conflict-race read-back (a concurrent writer, or an earlier
-- in-batch DISTINCT ON representative that this row's own producer/cuvee
-- pair matched but which wasn't visible as a "new_canon" row above).
insert into _identity_backfill_resolved (wine_id, canonical_wine_id, restaurant_id, vintage, size_ml)
select n.wine_id, cw.id, n.restaurant_id, n.vintage, n.size_ml
from _identity_backfill_norm n
join public.canonical_wines cw
  on cw.producer_norm = n.producer_norm and cw.cuvee_norm = n.cuvee_norm
where n.wine_id not in (select wine_id from _identity_backfill_resolved);

-------------------------------------------------------------------------------
-- Pass C: wine_variants — identical two-phase pattern keyed on
-- (restaurant_id, canonical_wine_id, coalesce(vintage,0), size_ml).
-------------------------------------------------------------------------------
drop table if exists _identity_backfill_variant;
create temporary table _identity_backfill_variant (
  wine_id         uuid primary key,
  wine_variant_id uuid not null
);

insert into _identity_backfill_variant (wine_id, wine_variant_id)
select r.wine_id, wv.id
from _identity_backfill_resolved r
join public.wine_variants wv
  on wv.restaurant_id = r.restaurant_id
 and wv.canonical_wine_id = r.canonical_wine_id
 and coalesce(wv.vintage, 0) = coalesce(r.vintage, 0)
 and wv.size_ml = r.size_ml;

with new_variants as (
  insert into public.wine_variants (restaurant_id, canonical_wine_id, vintage, size_ml)
  select distinct on (r.restaurant_id, r.canonical_wine_id, coalesce(r.vintage, 0), r.size_ml)
    r.restaurant_id, r.canonical_wine_id, r.vintage, r.size_ml
  from _identity_backfill_resolved r
  where r.wine_id not in (select wine_id from _identity_backfill_variant)
  order by r.restaurant_id, r.canonical_wine_id, coalesce(r.vintage, 0), r.size_ml, r.wine_id
  on conflict (restaurant_id, canonical_wine_id, coalesce(vintage, 0), size_ml) do nothing
  returning id, restaurant_id, canonical_wine_id, vintage, size_ml
)
insert into _identity_backfill_variant (wine_id, wine_variant_id)
select r.wine_id, nv.id
from _identity_backfill_resolved r
join new_variants nv
  on nv.restaurant_id = r.restaurant_id
 and nv.canonical_wine_id = r.canonical_wine_id
 and coalesce(nv.vintage, 0) = coalesce(r.vintage, 0)
 and nv.size_ml = r.size_ml
where r.wine_id not in (select wine_id from _identity_backfill_variant);

insert into _identity_backfill_variant (wine_id, wine_variant_id)
select r.wine_id, wv.id
from _identity_backfill_resolved r
join public.wine_variants wv
  on wv.restaurant_id = r.restaurant_id
 and wv.canonical_wine_id = r.canonical_wine_id
 and coalesce(wv.vintage, 0) = coalesce(r.vintage, 0)
 and wv.size_ml = r.size_ml
where r.wine_id not in (select wine_id from _identity_backfill_variant);

-------------------------------------------------------------------------------
-- Pass D: set wines.wine_variant_id. wines.canonical_wine_id is derived
-- by the wines_derive_canonical_wine_id trigger (0098) whenever
-- wine_variant_id changes, including from this bulk UPDATE — no separate
-- step needed here, and no reason to bypass the trigger: it always
-- computes the same value this backfill would set by hand, by
-- construction.
-------------------------------------------------------------------------------
update public.wines w
set wine_variant_id = v.wine_variant_id
from _identity_backfill_variant v
where w.id = v.wine_id;

drop table if exists _identity_backfill_variant;
drop table if exists _identity_backfill_resolved;
drop table if exists _identity_backfill_norm;
