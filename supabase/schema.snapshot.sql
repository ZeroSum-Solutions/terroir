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

-- === 0053_cellar_section_batch.sql ===
-- BND-064 / TER-020B15
-- Tenant-scoped cellar inventory discovery and atomic section assignment.

create or replace function public.cellar_inventory_wine_ids(
  p_restaurant_id uuid,
  p_wine_ids uuid[]
) returns uuid[]
language sql
security invoker
set search_path = ''
stable
as $$
  select coalesce(
    array_agg(distinct inventory_items.wine_id),
    '{}'::uuid[]
  )
  from public.inventory_items
  where inventory_items.restaurant_id = p_restaurant_id
    and inventory_items.wine_id = any(p_wine_ids);
$$;

revoke execute on function public.cellar_inventory_wine_ids(uuid, uuid[])
  from public;
grant execute on function public.cellar_inventory_wine_ids(uuid, uuid[])
  to authenticated;

create or replace function public.assign_cellar_section_batch(
  p_restaurant_id uuid,
  p_wine_ids uuid[],
  p_section text
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_updated_wine_ids uuid[];
begin
  if cardinality(p_wine_ids) < 1 or cardinality(p_wine_ids) > 200 then
    raise exception using
      errcode = 'P0001',
      message = 'cellar_batch_invalid_size';
  end if;

  if (
    select count(*) <> count(distinct wine_id)
    from unnest(p_wine_ids) as requested(wine_id)
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'cellar_batch_duplicate_wine';
  end if;

  if not exists (
    select 1
    from public.cellar_config
    cross join lateral jsonb_array_elements(
      coalesce(cellar_config.labels -> 'sections', '[]'::jsonb)
    ) as configured(section)
    where cellar_config.restaurant_id = p_restaurant_id
      and configured.section ->> 'name' = p_section
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'cellar_section_not_configured';
  end if;

  with updated as (
    update public.inventory_items
    set section = p_section
    where inventory_items.restaurant_id = p_restaurant_id
      and inventory_items.wine_id = any(p_wine_ids)
    returning inventory_items.wine_id
  )
  select coalesce(
    array_agg(distinct updated.wine_id),
    '{}'::uuid[]
  )
  into v_updated_wine_ids
  from updated;

  if cardinality(v_updated_wine_ids) <> cardinality(p_wine_ids) then
    raise exception using
      errcode = 'P0001',
      message = 'cellar_inventory_missing';
  end if;

  return;
end;
$$;

revoke execute on function public.assign_cellar_section_batch(
  uuid,
  uuid[],
  text
) from public;
grant execute on function public.assign_cellar_section_batch(
  uuid,
  uuid[],
  text
) to authenticated;

comment on function public.cellar_inventory_wine_ids(uuid, uuid[]) is
  'Returns distinct tenant-scoped inventory wine IDs for the requested wines.';
comment on function public.assign_cellar_section_batch(uuid, uuid[], text) is
  'Atomically validates and assigns tenant cellar inventory wines to a configured section; raises on any incomplete batch.';

-- === 0054_tenant_rpc_hardening.sql ===
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

-- === 0055_api_rate_limits.sql ===
-- TER-020D01 — distributed authenticated API rate limiting.
--
-- Every authenticated API operation consumes two fixed-window buckets in the
-- same database transaction:
--   1. a global per-user bucket; and
--   2. a per-user bucket for the operation's server-assigned risk class.
--
-- The function derives the user from auth.uid(). Callers cannot choose a
-- subject or a numerical limit. The backing table has no client-facing grants
-- or RLS policies; authenticated callers can interact only through the
-- SECURITY DEFINER function.

create table public.api_rate_limit_buckets (
  user_id         uuid        not null references auth.users(id) on delete cascade,
  bucket_key      text        not null check (
    bucket_key in (
      'global',
      'class:standard',
      'class:mutation',
      'class:expensive',
      'class:sensitive'
    )
  ),
  window_start    timestamptz not null,
  window_seconds  integer     not null check (window_seconds in (60, 3600)),
  request_count   bigint      not null check (request_count > 0),
  reset_at        timestamptz not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (user_id, bucket_key, window_start),
  constraint api_rate_limit_bucket_window
    check (
      reset_at
      = window_start + make_interval(secs => window_seconds)
    )
);

create index api_rate_limit_buckets_reset_at_idx
  on public.api_rate_limit_buckets (reset_at);

alter table public.api_rate_limit_buckets enable row level security;

revoke all on table public.api_rate_limit_buckets from public;
revoke all on table public.api_rate_limit_buckets from anon;
revoke all on table public.api_rate_limit_buckets from authenticated;

create or replace function public.consume_api_rate_limit(
  p_risk_class text
) returns table (
  allowed boolean,
  limit_count integer,
  remaining integer,
  retry_after_seconds integer,
  reset_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_now timestamptz := clock_timestamp();
  v_global_limit constant integer := 600;
  v_global_window_seconds constant integer := 60;
  v_class_limit integer;
  v_class_window_seconds integer;
  v_global_window_start timestamptz;
  v_class_window_start timestamptz;
  v_global_reset_at timestamptz;
  v_class_reset_at timestamptz;
  v_global_count bigint;
  v_class_count bigint;
  v_allowed boolean;
  v_effective_limit integer;
  v_effective_count bigint;
  v_effective_reset_at timestamptz;
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication required';
  end if;

  case p_risk_class
    when 'standard' then
      v_class_limit := 120;
      v_class_window_seconds := 60;
    when 'mutation' then
      v_class_limit := 60;
      v_class_window_seconds := 60;
    when 'expensive' then
      v_class_limit := 10;
      v_class_window_seconds := 60;
    when 'sensitive' then
      v_class_limit := 10;
      v_class_window_seconds := 3600;
    else
      raise exception using
        errcode = '22023',
        message = 'invalid API risk class';
  end case;

  v_global_window_start := to_timestamp(
    floor(
      extract(epoch from v_now) / v_global_window_seconds
    ) * v_global_window_seconds
  );
  v_class_window_start := to_timestamp(
    floor(
      extract(epoch from v_now) / v_class_window_seconds
    ) * v_class_window_seconds
  );
  v_global_reset_at :=
    v_global_window_start
    + make_interval(secs => v_global_window_seconds);
  v_class_reset_at :=
    v_class_window_start
    + make_interval(secs => v_class_window_seconds);

  -- All calls take the shared global bucket before their class bucket. This
  -- consistent lock order prevents cross-class deadlocks for one user.
  insert into public.api_rate_limit_buckets as bucket (
    user_id,
    bucket_key,
    window_start,
    window_seconds,
    request_count,
    reset_at
  ) values (
    v_user_id,
    'global',
    v_global_window_start,
    v_global_window_seconds,
    1,
    v_global_reset_at
  )
  on conflict (user_id, bucket_key, window_start)
  do update
  set request_count = bucket.request_count + 1,
      window_seconds = excluded.window_seconds,
      reset_at = excluded.reset_at,
      updated_at = v_now
  returning request_count into v_global_count;

  insert into public.api_rate_limit_buckets as bucket (
    user_id,
    bucket_key,
    window_start,
    window_seconds,
    request_count,
    reset_at
  ) values (
    v_user_id,
    'class:' || p_risk_class,
    v_class_window_start,
    v_class_window_seconds,
    1,
    v_class_reset_at
  )
  on conflict (user_id, bucket_key, window_start)
  do update
  set request_count = bucket.request_count + 1,
      window_seconds = excluded.window_seconds,
      reset_at = excluded.reset_at,
      updated_at = v_now
  returning request_count into v_class_count;

  v_allowed :=
    v_global_count <= v_global_limit
    and v_class_count <= v_class_limit;

  -- Successful requests report the risk-class bucket because it is the
  -- tighter normal limit. A rejected request reports the bucket whose reset
  -- must be awaited; if both reject, the later reset controls Retry-After.
  if v_global_count > v_global_limit
     and (
       v_class_count <= v_class_limit
       or v_global_reset_at > v_class_reset_at
     ) then
    v_effective_limit := v_global_limit;
    v_effective_count := v_global_count;
    v_effective_reset_at := v_global_reset_at;
  else
    v_effective_limit := v_class_limit;
    v_effective_count := v_class_count;
    v_effective_reset_at := v_class_reset_at;
  end if;

  return query
  select
    v_allowed,
    v_effective_limit,
    greatest(
      0,
      v_effective_limit - least(v_effective_count, 2147483647)::integer
    ),
    case
      when v_allowed then 0
      else greatest(
        1,
        ceil(
          extract(epoch from (v_effective_reset_at - v_now))
        )::integer
      )
    end,
    v_effective_reset_at;
end;
$$;

revoke all on function public.consume_api_rate_limit(text) from public;
revoke all on function public.consume_api_rate_limit(text) from anon;
grant execute on function public.consume_api_rate_limit(text) to authenticated;

create or replace function public.cleanup_api_rate_limit_buckets()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted bigint;
begin
  delete from public.api_rate_limit_buckets
  where reset_at < clock_timestamp() - interval '1 hour';

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.cleanup_api_rate_limit_buckets() from public;
revoke all on function public.cleanup_api_rate_limit_buckets() from anon;
revoke all on function public.cleanup_api_rate_limit_buckets()
  from authenticated;
grant execute on function public.cleanup_api_rate_limit_buckets()
  to service_role;

select cron.schedule(
  'cleanup_api_rate_limit_buckets_hourly',
  '15 * * * *',
  $$select public.cleanup_api_rate_limit_buckets();$$
);

comment on table public.api_rate_limit_buckets is
  'Distributed fixed-window counters for authenticated per-user API limits.';

comment on function public.consume_api_rate_limit(text) is
  'Atomically consumes per-user global and risk-class API buckets using hardcoded server-side limits.';

comment on function public.cleanup_api_rate_limit_buckets() is
  'Deletes API rate-limit buckets more than one hour past their reset time.';

-- === 0056_api_idempotency.sql ===
-- TER-020D02 — generalized authenticated request idempotency.
--
-- A key is globally bound per authenticated user. Tenant, operation, and
-- request hash are immutable attributes of that binding, so cross-endpoint or
-- cross-tenant reuse cannot silently create a second mutation. The table is
-- not a client API: authenticated callers can only use the SECURITY DEFINER
-- RPCs below.

create table public.api_idempotency (
  restaurant_id   uuid        not null references public.restaurants(id) on delete cascade,
  user_id         uuid        not null references auth.users(id) on delete cascade,
  operation_id    text        not null check (
    operation_id ~ '^[A-Za-z0-9][A-Za-z0-9:/_.{}-]{0,199}$'
  ),
  idempotency_key text        not null check (
    char_length(idempotency_key) between 8 and 128
    and idempotency_key ~ '^[A-Za-z0-9_-]+$'
  ),
  request_hash    text        not null check (
    request_hash ~ '^[0-9a-f]{64}$'
  ),
  state           text        not null default 'in_progress' check (
    state in ('in_progress', 'completed', 'failed_unknown')
  ),
  response_status integer,
  response_headers jsonb,
  response_body   jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  completed_at    timestamptz,
  primary key (user_id, idempotency_key),
  constraint api_idempotency_response_state check (
    (
      state = 'in_progress'
      and response_status is null
      and response_headers is null
      and response_body is null
      and completed_at is null
    )
    or (
      state = 'failed_unknown'
      and response_status is null
      and response_headers is null
      and response_body is null
      and completed_at is null
    )
    or (
      state = 'completed'
      and response_status between 100 and 599
      and jsonb_typeof(response_headers) = 'object'
      and response_body is not null
      and completed_at is not null
    )
  )
);

create index api_idempotency_updated_at_idx
  on public.api_idempotency (updated_at);

alter table public.api_idempotency enable row level security;

revoke all on table public.api_idempotency from public;
revoke all on table public.api_idempotency from anon;
revoke all on table public.api_idempotency from authenticated;

create or replace function public.claim_api_idempotency(
  p_restaurant_id uuid,
  p_operation_id text,
  p_idempotency_key text,
  p_request_hash text
) returns table (
  outcome text,
  response_status integer,
  response_headers jsonb,
  response_body jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_claim public.api_idempotency%rowtype;
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication required';
  end if;

  if p_restaurant_id is null then
    raise exception using
      errcode = '22023',
      message = 'restaurant_id is required';
  end if;

  if p_operation_id is null
     or p_operation_id !~ '^[A-Za-z0-9][A-Za-z0-9:/_.{}-]{0,199}$' then
    raise exception using
      errcode = '22023',
      message = 'invalid operation_id';
  end if;

  if p_idempotency_key is null
     or char_length(p_idempotency_key) not between 8 and 128
     or p_idempotency_key !~ '^[A-Za-z0-9_-]+$' then
    raise exception using
      errcode = '22023',
      message = 'invalid idempotency key';
  end if;

  if p_request_hash is null
     or p_request_hash !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = '22023',
      message = 'invalid request hash';
  end if;

  if not exists (
    select 1
    from public.memberships
    where memberships.restaurant_id = p_restaurant_id
      and memberships.user_id = v_user_id
  ) then
    raise exception using
      errcode = '42501',
      message = 'forbidden';
  end if;

  loop
    insert into public.api_idempotency (
      restaurant_id,
      user_id,
      operation_id,
      idempotency_key,
      request_hash
    ) values (
      p_restaurant_id,
      v_user_id,
      p_operation_id,
      p_idempotency_key,
      p_request_hash
    )
    on conflict (user_id, idempotency_key) do nothing
    returning * into v_claim;

    if found then
      return query
      select
        'claimed'::text,
        null::integer,
        null::jsonb,
        null::jsonb;
      return;
    end if;

    -- ON CONFLICT waits for a concurrent winner to commit or roll back. Each
    -- PL/pgSQL statement receives a fresh READ COMMITTED snapshot, so this
    -- lookup observes the committed winner. A concurrent release/cleanup can
    -- still remove it before the SELECT; in that case, loop and claim again.
    select *
    into v_claim
    from public.api_idempotency
    where api_idempotency.user_id = v_user_id
      and api_idempotency.idempotency_key = p_idempotency_key;

    if not found then
      continue;
    end if;

    if v_claim.restaurant_id <> p_restaurant_id
       or v_claim.operation_id <> p_operation_id
       or v_claim.request_hash <> p_request_hash then
      return query
      select
        'mismatch'::text,
        null::integer,
        null::jsonb,
        null::jsonb;
      return;
    end if;

    if v_claim.updated_at < clock_timestamp() - interval '24 hours' then
      return query
      select
        'expired'::text,
        null::integer,
        null::jsonb,
        null::jsonb;
      return;
    end if;

    if v_claim.state = 'completed' then
      return query
      select
        'replay'::text,
        v_claim.response_status,
        v_claim.response_headers,
        v_claim.response_body;
      return;
    end if;

    if v_claim.state = 'failed_unknown' then
      return query
      select
        'outcome_unknown'::text,
        null::integer,
        null::jsonb,
        null::jsonb;
      return;
    end if;

    return query
    select
      'in_progress'::text,
      null::integer,
      null::jsonb,
      null::jsonb;
    return;
  end loop;
end;
$$;

revoke all on function public.claim_api_idempotency(
  uuid,
  text,
  text,
  text
) from public;
revoke all on function public.claim_api_idempotency(
  uuid,
  text,
  text,
  text
) from anon;
grant execute on function public.claim_api_idempotency(
  uuid,
  text,
  text,
  text
) to authenticated;

create or replace function public.complete_api_idempotency(
  p_restaurant_id uuid,
  p_operation_id text,
  p_idempotency_key text,
  p_request_hash text,
  p_response_status integer,
  p_response_headers jsonb,
  p_response_body jsonb
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_now timestamptz;
  v_updated boolean;
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication required';
  end if;

  if p_restaurant_id is null then
    raise exception using
      errcode = '22023',
      message = 'restaurant_id is required';
  end if;

  if p_operation_id is null
     or p_operation_id !~ '^[A-Za-z0-9][A-Za-z0-9:/_.{}-]{0,199}$' then
    raise exception using
      errcode = '22023',
      message = 'invalid operation_id';
  end if;

  if p_idempotency_key is null
     or char_length(p_idempotency_key) not between 8 and 128
     or p_idempotency_key !~ '^[A-Za-z0-9_-]+$' then
    raise exception using
      errcode = '22023',
      message = 'invalid idempotency key';
  end if;

  if p_request_hash is null
     or p_request_hash !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = '22023',
      message = 'invalid request hash';
  end if;

  if p_response_status is null
     or p_response_status not between 100 and 599 then
    raise exception using
      errcode = '22023',
      message = 'invalid response status';
  end if;

  if p_response_body is null then
    raise exception using
      errcode = '22023',
      message = 'response body is required';
  end if;

  if p_response_headers is null
     or jsonb_typeof(p_response_headers) <> 'object' then
    raise exception using
      errcode = '22023',
      message = 'response headers must be a JSON object';
  end if;

  if octet_length(p_response_headers::text) > 65536 then
    raise exception using
      errcode = '22023',
      message = 'response headers exceed 64 KiB';
  end if;

  if octet_length(p_response_body::text) > 1048576 then
    raise exception using
      errcode = '22023',
      message = 'response body exceeds 1 MiB';
  end if;

  v_now := clock_timestamp();

  update public.api_idempotency
  set state = 'completed',
      response_status = p_response_status,
      response_headers = p_response_headers,
      response_body = p_response_body,
      updated_at = v_now,
      completed_at = v_now
  where api_idempotency.restaurant_id = p_restaurant_id
    and api_idempotency.user_id = v_user_id
    and api_idempotency.operation_id = p_operation_id
    and api_idempotency.idempotency_key = p_idempotency_key
    and api_idempotency.request_hash = p_request_hash
    and api_idempotency.state = 'in_progress'
  returning true into v_updated;

  return coalesce(v_updated, false);
end;
$$;

revoke all on function public.complete_api_idempotency(
  uuid,
  text,
  text,
  text,
  integer,
  jsonb,
  jsonb
) from public;
revoke all on function public.complete_api_idempotency(
  uuid,
  text,
  text,
  text,
  integer,
  jsonb,
  jsonb
) from anon;
grant execute on function public.complete_api_idempotency(
  uuid,
  text,
  text,
  text,
  integer,
  jsonb,
  jsonb
) to authenticated;

create or replace function public.fail_api_idempotency(
  p_restaurant_id uuid,
  p_operation_id text,
  p_idempotency_key text,
  p_request_hash text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_updated boolean;
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication required';
  end if;

  if p_restaurant_id is null then
    raise exception using
      errcode = '22023',
      message = 'restaurant_id is required';
  end if;

  if p_operation_id is null
     or p_operation_id !~ '^[A-Za-z0-9][A-Za-z0-9:/_.{}-]{0,199}$' then
    raise exception using
      errcode = '22023',
      message = 'invalid operation_id';
  end if;

  if p_idempotency_key is null
     or char_length(p_idempotency_key) not between 8 and 128
     or p_idempotency_key !~ '^[A-Za-z0-9_-]+$' then
    raise exception using
      errcode = '22023',
      message = 'invalid idempotency key';
  end if;

  if p_request_hash is null
     or p_request_hash !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = '22023',
      message = 'invalid request hash';
  end if;

  update public.api_idempotency
  set state = 'failed_unknown',
      updated_at = clock_timestamp()
  where api_idempotency.user_id = v_user_id
    and api_idempotency.idempotency_key = p_idempotency_key
    and api_idempotency.restaurant_id = p_restaurant_id
    and api_idempotency.operation_id = p_operation_id
    and api_idempotency.request_hash = p_request_hash
    and api_idempotency.state = 'in_progress'
  returning true into v_updated;

  return coalesce(v_updated, false);
end;
$$;

revoke all on function public.fail_api_idempotency(
  uuid,
  text,
  text,
  text
) from public;
revoke all on function public.fail_api_idempotency(
  uuid,
  text,
  text,
  text
) from anon;
grant execute on function public.fail_api_idempotency(
  uuid,
  text,
  text,
  text
) to authenticated;

create or replace function public.release_api_idempotency(
  p_restaurant_id uuid,
  p_operation_id text,
  p_idempotency_key text,
  p_request_hash text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_deleted boolean;
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication required';
  end if;

  if p_restaurant_id is null then
    raise exception using
      errcode = '22023',
      message = 'restaurant_id is required';
  end if;

  if p_operation_id is null
     or p_operation_id !~ '^[A-Za-z0-9][A-Za-z0-9:/_.{}-]{0,199}$' then
    raise exception using
      errcode = '22023',
      message = 'invalid operation_id';
  end if;

  if p_idempotency_key is null
     or char_length(p_idempotency_key) not between 8 and 128
     or p_idempotency_key !~ '^[A-Za-z0-9_-]+$' then
    raise exception using
      errcode = '22023',
      message = 'invalid idempotency key';
  end if;

  if p_request_hash is null
     or p_request_hash !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = '22023',
      message = 'invalid request hash';
  end if;

  delete from public.api_idempotency
  where api_idempotency.restaurant_id = p_restaurant_id
    and api_idempotency.user_id = v_user_id
    and api_idempotency.operation_id = p_operation_id
    and api_idempotency.idempotency_key = p_idempotency_key
    and api_idempotency.request_hash = p_request_hash
    and api_idempotency.state = 'in_progress'
  returning true into v_deleted;

  return coalesce(v_deleted, false);
end;
$$;

revoke all on function public.release_api_idempotency(
  uuid,
  text,
  text,
  text
) from public;
revoke all on function public.release_api_idempotency(
  uuid,
  text,
  text,
  text
) from anon;
grant execute on function public.release_api_idempotency(
  uuid,
  text,
  text,
  text
) to authenticated;

create or replace function public.cleanup_api_idempotency()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted bigint;
begin
  delete from public.api_idempotency
  where updated_at < clock_timestamp() - interval '25 hours';

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.cleanup_api_idempotency() from public;
revoke all on function public.cleanup_api_idempotency() from anon;
revoke all on function public.cleanup_api_idempotency()
  from authenticated;
grant execute on function public.cleanup_api_idempotency()
  to service_role;

select cron.schedule(
  'cleanup_api_idempotency_hourly',
  '25 * * * *',
  $$select public.cleanup_api_idempotency();$$
);

comment on table public.api_idempotency is
  'Per-user request-key bindings with a 24-hour observable TTL and 25-hour cleanup window.';

comment on function public.claim_api_idempotency(uuid, text, text, text) is
  'Atomically binds a user key or returns replay, in-progress, mismatch, expired, or outcome-unknown.';

comment on function public.complete_api_idempotency(
  uuid,
  text,
  text,
  text,
  integer,
  jsonb,
  jsonb
) is
  'Completes a matching caller-owned claim with a cached HTTP status, headers, and JSON body.';

comment on function public.fail_api_idempotency(uuid, text, text, text) is
  'Marks a matching caller-owned in-progress claim as having an ambiguous mutation outcome.';

comment on function public.release_api_idempotency(uuid, text, text, text) is
  'Releases only a matching caller-owned in-progress claim.';

comment on function public.cleanup_api_idempotency() is
  'Deletes request-idempotency rows whose last update is older than 25 hours.';

-- === 0057_atomic_idempotent_commands.sql ===
-- TER-020D03 — atomic high-risk command boundaries.
--
-- Opening a bottle previously decremented sealed inventory before attempting
-- a client-forbidden open_bottles write. Invitation acceptance attempted two
-- independently committed writes through RLS that excludes non-members. These
-- definer RPCs make each command one transaction and retain all caller,
-- tenant, and request-key checks inside that transaction.

do $$
begin
  if exists (
    select 1
    from public.invitations
    where invitations.role not in ('manager', 'staff')
  ) then
    raise exception using
      errcode = '23514',
      message =
        'atomic_invitation_preflight_failed: invitations contain a forbidden owner role';
  end if;
end;
$$;

alter table public.invitations
  add constraint invitations_invitable_role_check
  check (role in ('manager', 'staff'));

create or replace function public.open_bottle_from_inventory(
  p_restaurant_id uuid,
  p_wine_id uuid
) returns table (
  outcome text,
  bottle_id uuid,
  wine_id uuid,
  remaining_ml integer,
  opened_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_wine public.wines%rowtype;
  v_inventory public.inventory_items%rowtype;
  v_bottle public.open_bottles%rowtype;
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication required';
  end if;

  if p_restaurant_id is null or p_wine_id is null then
    raise exception using
      errcode = '22023',
      message = 'restaurant_id and wine_id are required';
  end if;

  if not public.is_member_with_role(p_restaurant_id, 'staff') then
    raise exception using
      errcode = '42501',
      message = 'forbidden';
  end if;

  -- The wine lock serializes every manual-open command for this wine. It also
  -- makes each later inventory lookup observe the preceding command's commit.
  select *
  into v_wine
  from public.wines
  where wines.id = p_wine_id
    and wines.restaurant_id = p_restaurant_id
  for update;

  if not found then
    return query
    select
      'not_found'::text,
      null::uuid,
      null::uuid,
      null::integer,
      null::timestamptz;
    return;
  end if;

  -- Match record_pour's lock order (open bottle before inventory) so a
  -- simultaneous pour and manual-open cannot deadlock while taking the same
  -- two row locks.
  select *
  into v_bottle
  from public.open_bottles
  where open_bottles.wine_id = p_wine_id
    and open_bottles.restaurant_id = p_restaurant_id
  for update;

  select *
  into v_inventory
  from public.inventory_items
  where inventory_items.wine_id = p_wine_id
    and inventory_items.restaurant_id = p_restaurant_id
    and inventory_items.quantity > 0
  order by inventory_items.added_at, inventory_items.id
  limit 1
  for update;

  if not found then
    return query
    select
      'no_sealed_stock'::text,
      null::uuid,
      null::uuid,
      null::integer,
      null::timestamptz;
    return;
  end if;

  update public.inventory_items
  set quantity = quantity - 1
  where inventory_items.id = v_inventory.id
    and inventory_items.wine_id = p_wine_id
    and inventory_items.restaurant_id = p_restaurant_id
    and inventory_items.quantity > 0;

  if not found then
    raise exception using
      errcode = '40001',
      message = 'sealed inventory changed concurrently';
  end if;

  insert into public.open_bottles (
    wine_id,
    restaurant_id,
    remaining_ml,
    opened_at,
    opened_by,
    source_inventory_item_id,
    closed_at
  ) values (
    p_wine_id,
    p_restaurant_id,
    coalesce(v_wine.size_ml, 750),
    clock_timestamp(),
    v_user_id,
    v_inventory.id,
    null
  )
  on conflict on constraint open_bottles_wine_id_restaurant_id_key
  do update set
    remaining_ml = excluded.remaining_ml,
    opened_at = excluded.opened_at,
    opened_by = excluded.opened_by,
    source_inventory_item_id = excluded.source_inventory_item_id,
    closed_at = null
  returning * into v_bottle;

  return query
  select
    'opened'::text,
    v_bottle.id,
    v_bottle.wine_id,
    v_bottle.remaining_ml,
    v_bottle.opened_at;
end;
$$;

revoke all on function public.open_bottle_from_inventory(uuid, uuid)
  from public;
revoke all on function public.open_bottle_from_inventory(uuid, uuid)
  from anon;
grant execute on function public.open_bottle_from_inventory(uuid, uuid)
  to authenticated;

create or replace function public.accept_invitation_idempotent(
  p_token text,
  p_idempotency_key text default null,
  p_request_hash text default null
) returns table (
  outcome text,
  response_status integer,
  response_body jsonb,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_user_email text;
  v_invitation public.invitations%rowtype;
  v_idempotency public.api_idempotency%rowtype;
  v_existing_member boolean;
  v_body jsonb;
  v_now timestamptz;
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication required';
  end if;

  if p_token is null or btrim(p_token) = '' then
    raise exception using
      errcode = '22023',
      message = 'invitation token is required';
  end if;

  if p_idempotency_key is null and p_request_hash is not null then
    raise exception using
      errcode = '22023',
      message = 'request hash requires an idempotency key';
  end if;

  if p_idempotency_key is not null then
    if char_length(p_idempotency_key) not between 8 and 128
       or p_idempotency_key !~ '^[A-Za-z0-9_-]+$' then
      raise exception using
        errcode = '22023',
        message = 'invalid idempotency key';
    end if;
    if p_request_hash is null
       or p_request_hash !~ '^[0-9a-f]{64}$' then
      raise exception using
        errcode = '22023',
        message = 'invalid request hash';
    end if;

    -- Serialize dedicated accept calls for one user/key before reading the
    -- binding. A hash collision only serializes unrelated callers.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        v_user_id::text || ':' || p_idempotency_key,
        0
      )
    );

    select *
    into v_idempotency
    from public.api_idempotency
    where api_idempotency.user_id = v_user_id
      and api_idempotency.idempotency_key = p_idempotency_key
    for update;

    if found then
      if v_idempotency.operation_id
           <> 'api:POST:/api/team/accept-invite'
         or v_idempotency.request_hash <> p_request_hash then
        return query
        select
          'idempotency_key_reused'::text,
          409,
          jsonb_build_object(
            'error',
            jsonb_build_object(
              'code', 'idempotency_key_reused',
              'message',
              'This Idempotency-Key was already used for a different request.'
            )
          ),
          false;
        return;
      end if;

      if v_idempotency.updated_at
           < clock_timestamp() - interval '24 hours' then
        return query
        select
          'idempotency_key_expired'::text,
          409,
          jsonb_build_object(
            'error',
            jsonb_build_object(
              'code', 'idempotency_key_expired',
              'message', 'This Idempotency-Key has expired.'
            )
          ),
          false;
        return;
      end if;

      if v_idempotency.state = 'completed' then
        return query
        select
          'replay'::text,
          v_idempotency.response_status,
          v_idempotency.response_body,
          true;
        return;
      end if;

      if v_idempotency.state = 'failed_unknown' then
        return query
        select
          'idempotency_outcome_unknown'::text,
          409,
          jsonb_build_object(
            'error',
            jsonb_build_object(
              'code', 'idempotency_outcome_unknown',
              'message',
              'The original request outcome is unknown and will not be retried.'
            )
          ),
          false;
        return;
      end if;

      return query
      select
        'idempotency_in_progress'::text,
        409,
        jsonb_build_object(
          'error',
          jsonb_build_object(
            'code', 'idempotency_in_progress',
            'message',
            'A request with this Idempotency-Key is still in progress.'
          )
        ),
        false;
      return;
    end if;
  end if;

  select lower(btrim(users.email))
  into v_user_email
  from auth.users
  where users.id = v_user_id;

  if v_user_email is null or v_user_email = '' then
    return query
    select
      'not_found'::text,
      404,
      jsonb_build_object(
        'error',
        jsonb_build_object(
          'code', 'not_found',
          'message', 'Invalid or expired invitation.'
        )
      ),
      false;
    return;
  end if;

  select *
  into v_invitation
  from public.invitations
  where invitations.token = p_token
    and lower(btrim(invitations.email)) = v_user_email
  for update;

  if not found then
    return query
    select
      'not_found'::text,
      404,
      jsonb_build_object(
        'error',
        jsonb_build_object(
          'code', 'not_found',
          'message', 'Invalid or expired invitation.'
        )
      ),
      false;
    return;
  end if;

  if v_invitation.role not in ('manager', 'staff') then
    return query
    select
      'not_found'::text,
      404,
      jsonb_build_object(
        'error',
        jsonb_build_object(
          'code', 'not_found',
          'message', 'Invalid or expired invitation.'
        )
      ),
      false;
    return;
  end if;

  if p_idempotency_key is not null then
    insert into public.api_idempotency (
      restaurant_id,
      user_id,
      operation_id,
      idempotency_key,
      request_hash
    ) values (
      v_invitation.restaurant_id,
      v_user_id,
      'api:POST:/api/team/accept-invite',
      p_idempotency_key,
      p_request_hash
    )
    on conflict (user_id, idempotency_key) do nothing;

    if not found then
      -- A generic claim can race the advisory-locked dedicated function. The
      -- unique key is authoritative, so classify that committed winner.
      select *
      into v_idempotency
      from public.api_idempotency
      where api_idempotency.user_id = v_user_id
        and api_idempotency.idempotency_key = p_idempotency_key
      for update;

      if v_idempotency.restaurant_id <> v_invitation.restaurant_id
         or v_idempotency.operation_id
              <> 'api:POST:/api/team/accept-invite'
         or v_idempotency.request_hash <> p_request_hash then
        return query
        select
          'idempotency_key_reused'::text,
          409,
          jsonb_build_object(
            'error',
            jsonb_build_object(
              'code', 'idempotency_key_reused',
              'message',
              'This Idempotency-Key was already used for a different request.'
            )
          ),
          false;
        return;
      end if;

      if v_idempotency.updated_at
           < clock_timestamp() - interval '24 hours' then
        return query
        select
          'idempotency_key_expired'::text,
          409,
          jsonb_build_object(
            'error',
            jsonb_build_object(
              'code', 'idempotency_key_expired',
              'message', 'This Idempotency-Key has expired.'
            )
          ),
          false;
        return;
      end if;

      if v_idempotency.state = 'completed' then
        return query
        select
          'replay'::text,
          v_idempotency.response_status,
          v_idempotency.response_body,
          true;
        return;
      end if;

      if v_idempotency.state = 'failed_unknown' then
        return query
        select
          'idempotency_outcome_unknown'::text,
          409,
          jsonb_build_object(
            'error',
            jsonb_build_object(
              'code', 'idempotency_outcome_unknown',
              'message',
              'The original request outcome is unknown and will not be retried.'
            )
          ),
          false;
        return;
      end if;

      return query
      select
        'idempotency_in_progress'::text,
        409,
        jsonb_build_object(
          'error',
          jsonb_build_object(
            'code', 'idempotency_in_progress',
            'message',
            'A request with this Idempotency-Key is still in progress.'
          )
        ),
        false;
      return;
    end if;
  end if;

  if v_invitation.accepted_at is not null then
    v_body := jsonb_build_object(
      'error',
      jsonb_build_object(
        'code', 'bad_request',
        'message', 'This invitation has already been used.'
      )
    );
    if p_idempotency_key is not null then
      update public.api_idempotency
      set state = 'completed',
          response_status = 400,
          response_headers = '{}'::jsonb,
          response_body = v_body,
          updated_at = clock_timestamp(),
          completed_at = clock_timestamp()
      where api_idempotency.user_id = v_user_id
        and api_idempotency.idempotency_key = p_idempotency_key
        and api_idempotency.state = 'in_progress';
    end if;
    return query select 'already_used'::text, 400, v_body, false;
    return;
  end if;

  if v_invitation.expires_at < clock_timestamp() then
    v_body := jsonb_build_object(
      'error',
      jsonb_build_object(
        'code', 'bad_request',
        'message', 'This invitation has expired.'
      )
    );
    if p_idempotency_key is not null then
      update public.api_idempotency
      set state = 'completed',
          response_status = 400,
          response_headers = '{}'::jsonb,
          response_body = v_body,
          updated_at = clock_timestamp(),
          completed_at = clock_timestamp()
      where api_idempotency.user_id = v_user_id
        and api_idempotency.idempotency_key = p_idempotency_key
        and api_idempotency.state = 'in_progress';
    end if;
    return query select 'invitation_expired'::text, 400, v_body, false;
    return;
  end if;

  select exists (
    select 1
    from public.memberships
    where memberships.user_id = v_user_id
      and memberships.restaurant_id = v_invitation.restaurant_id
  )
  into v_existing_member;

  insert into public.memberships (
    user_id,
    restaurant_id,
    role
  ) values (
    v_user_id,
    v_invitation.restaurant_id,
    v_invitation.role
  )
  on conflict (user_id, restaurant_id) do nothing;

  v_now := clock_timestamp();
  update public.invitations
  set accepted_at = v_now
  where invitations.id = v_invitation.id
    and invitations.accepted_at is null;

  if not found then
    raise exception using
      errcode = '40001',
      message = 'invitation acceptance changed concurrently';
  end if;

  v_body := jsonb_build_object(
    'success', true,
    case when v_existing_member then 'message' else 'role' end,
    case
      when v_existing_member
        then 'You are already a member of this restaurant.'
      else v_invitation.role::text
    end,
    'restaurantId', v_invitation.restaurant_id
  );

  if p_idempotency_key is not null then
    update public.api_idempotency
    set state = 'completed',
        response_status = 200,
        response_headers = '{}'::jsonb,
        response_body = v_body,
        updated_at = v_now,
        completed_at = v_now
    where api_idempotency.user_id = v_user_id
      and api_idempotency.idempotency_key = p_idempotency_key
      and api_idempotency.restaurant_id = v_invitation.restaurant_id
      and api_idempotency.operation_id
            = 'api:POST:/api/team/accept-invite'
      and api_idempotency.request_hash = p_request_hash
      and api_idempotency.state = 'in_progress';

    if not found then
      raise exception using
        errcode = '40001',
        message = 'idempotency completion changed concurrently';
    end if;
  end if;

  return query select 'accepted'::text, 200, v_body, false;
end;
$$;

revoke all on function public.accept_invitation_idempotent(text, text, text)
  from public;
revoke all on function public.accept_invitation_idempotent(text, text, text)
  from anon;
grant execute on function public.accept_invitation_idempotent(text, text, text)
  to authenticated;

comment on function public.open_bottle_from_inventory(uuid, uuid) is
  'Atomically decrements one sealed unit and opens or replaces the caller-tenant bottle.';

comment on function public.accept_invitation_idempotent(text, text, text) is
  'Atomically validates and accepts an email-bound invitation with optional exact-response idempotency.';

-- === 0058_open_bottle_idempotency.sql ===
-- TER-020D03 follow-up — make the open-bottle mutation and its idempotency
-- response one transaction.
--
-- The generic API wrapper committed open_bottle_from_inventory before calling
-- complete_api_idempotency. A completion failure could therefore consume a
-- sealed bottle while leaving the key permanently in progress. This dedicated
-- boundary binds the claim, existing atomic mutation, and stored response to
-- the transaction of one PostgreSQL statement.

create or replace function public.open_bottle_from_inventory_idempotent(
  p_restaurant_id uuid,
  p_wine_id uuid,
  p_idempotency_key text default null,
  p_request_hash text default null
) returns table (
  outcome text,
  response_status integer,
  response_body jsonb,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_claim public.api_idempotency%rowtype;
  v_open record;
  v_body jsonb;
  v_status integer;
  v_now timestamptz;
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication required';
  end if;

  if p_restaurant_id is null or p_wine_id is null then
    raise exception using
      errcode = '22023',
      message = 'restaurant_id and wine_id are required';
  end if;

  if not public.is_member_with_role(p_restaurant_id, 'staff') then
    raise exception using
      errcode = '42501',
      message = 'forbidden';
  end if;

  if p_idempotency_key is null and p_request_hash is not null then
    raise exception using
      errcode = '22023',
      message = 'request hash requires an idempotency key';
  end if;

  if p_idempotency_key is not null then
    if char_length(p_idempotency_key) not between 8 and 128
       or p_idempotency_key !~ '^[A-Za-z0-9_-]+$' then
      raise exception using
        errcode = '22023',
        message = 'invalid idempotency key';
    end if;

    if p_request_hash is null
       or p_request_hash !~ '^[0-9a-f]{64}$' then
      raise exception using
        errcode = '22023',
        message = 'invalid request hash';
    end if;

    -- Serialize dedicated open calls for one user/key. A generic claim from an
    -- older application process can still race this function; the loop treats
    -- the unique key as authoritative after that transaction commits.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        v_user_id::text || ':' || p_idempotency_key,
        0
      )
    );

    loop
      select *
      into v_claim
      from public.api_idempotency
      where api_idempotency.user_id = v_user_id
        and api_idempotency.idempotency_key = p_idempotency_key
      for update;

      if found then
        if v_claim.restaurant_id <> p_restaurant_id
           or v_claim.operation_id <> 'api:POST:/api/open-bottles'
           or v_claim.request_hash <> p_request_hash then
          return query
          select
            'idempotency_key_reused'::text,
            409,
            jsonb_build_object(
              'error',
              jsonb_build_object(
                'code', 'idempotency_key_reused',
                'message',
                'This Idempotency-Key was already used for a different request.'
              )
            ),
            false;
          return;
        end if;

        if v_claim.updated_at
             < clock_timestamp() - interval '24 hours' then
          return query
          select
            'idempotency_key_expired'::text,
            409,
            jsonb_build_object(
              'error',
              jsonb_build_object(
                'code', 'idempotency_key_expired',
                'message', 'This Idempotency-Key has expired.'
              )
            ),
            false;
          return;
        end if;

        if v_claim.state = 'completed' then
          return query
          select
            'replay'::text,
            v_claim.response_status,
            v_claim.response_body,
            true;
          return;
        end if;

        if v_claim.state = 'failed_unknown' then
          return query
          select
            'idempotency_outcome_unknown'::text,
            409,
            jsonb_build_object(
              'error',
              jsonb_build_object(
                'code', 'idempotency_outcome_unknown',
                'message',
                'The original request outcome is unknown and will not be retried.'
              )
            ),
            false;
          return;
        end if;

        return query
        select
          'idempotency_in_progress'::text,
          409,
          jsonb_build_object(
            'error',
            jsonb_build_object(
              'code', 'idempotency_in_progress',
              'message',
              'A request with this Idempotency-Key is still in progress.'
            )
          ),
          false;
        return;
      end if;

      insert into public.api_idempotency (
        restaurant_id,
        user_id,
        operation_id,
        idempotency_key,
        request_hash
      ) values (
        p_restaurant_id,
        v_user_id,
        'api:POST:/api/open-bottles',
        p_idempotency_key,
        p_request_hash
      )
      on conflict (user_id, idempotency_key) do nothing;

      if found then
        exit;
      end if;
    end loop;
  end if;

  select *
  into v_open
  from public.open_bottle_from_inventory(
    p_restaurant_id,
    p_wine_id
  );

  if not found then
    raise exception using
      errcode = '40001',
      message = 'open bottle command returned no result';
  end if;

  if v_open.outcome = 'not_found' then
    v_status := 404;
    v_body := jsonb_build_object(
      'error',
      jsonb_build_object(
        'code', 'not_found',
        'message', 'Wine not found.'
      )
    );
  elsif v_open.outcome = 'no_sealed_stock' then
    v_status := 409;
    v_body := jsonb_build_object(
      'error',
      jsonb_build_object(
        'code', 'no_sealed_stock',
        'message', 'No sealed bottles available to open.'
      )
    );
  elsif v_open.outcome = 'opened'
        and v_open.bottle_id is not null
        and v_open.wine_id is not null
        and v_open.remaining_ml is not null
        and v_open.opened_at is not null then
    v_status := 201;
    v_body := jsonb_build_object(
      'open_bottle',
      jsonb_build_object(
        'id', v_open.bottle_id,
        'wine_id', v_open.wine_id,
        'remaining_ml', v_open.remaining_ml,
        'opened_at', v_open.opened_at
      )
    );
  else
    raise exception using
      errcode = '40001',
      message = 'open bottle command returned an invalid result';
  end if;

  if p_idempotency_key is not null then
    v_now := clock_timestamp();
    update public.api_idempotency
    set state = 'completed',
        response_status = v_status,
        response_headers = '{}'::jsonb,
        response_body = v_body,
        updated_at = v_now,
        completed_at = v_now
    where api_idempotency.restaurant_id = p_restaurant_id
      and api_idempotency.user_id = v_user_id
      and api_idempotency.operation_id = 'api:POST:/api/open-bottles'
      and api_idempotency.idempotency_key = p_idempotency_key
      and api_idempotency.request_hash = p_request_hash
      and api_idempotency.state = 'in_progress';

    if not found then
      raise exception using
        errcode = '40001',
        message = 'idempotency completion changed concurrently';
    end if;
  end if;

  return query
  select v_open.outcome::text, v_status, v_body, false;
end;
$$;

revoke all on function public.open_bottle_from_inventory_idempotent(
  uuid,
  uuid,
  text,
  text
) from public;
revoke all on function public.open_bottle_from_inventory_idempotent(
  uuid,
  uuid,
  text,
  text
) from anon;
grant execute on function public.open_bottle_from_inventory_idempotent(
  uuid,
  uuid,
  text,
  text
) to authenticated;

comment on function public.open_bottle_from_inventory_idempotent(
  uuid,
  uuid,
  text,
  text
) is
  'Atomically opens sealed inventory and stores or replays its exact keyed response.';

-- === 0059_close_open_bottle_idempotency.sql ===
-- TER-020D08 — atomically close one exact open-bottle generation and store
-- or replay the command response.
--
-- The previous route read the bottle and then called record_pour in separate
-- statements. That could close a replacement bottle after a stale page action
-- and could commit the spill before an idempotency response was durable. This
-- dedicated boundary binds generation validation, spill, trigger-maintained
-- state, and response completion to one PostgreSQL transaction.

create or replace function public.close_open_bottle_idempotent(
  p_restaurant_id uuid,
  p_bottle_id uuid,
  p_expected_opened_at timestamptz,
  p_idempotency_key text default null,
  p_request_hash text default null
) returns table (
  outcome text,
  response_status integer,
  response_body jsonb,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_claim public.api_idempotency%rowtype;
  v_bottle public.open_bottles%rowtype;
  v_wine_id uuid;
  v_body jsonb;
  v_status integer;
  v_outcome text;
  v_now timestamptz;
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication required';
  end if;

  if p_restaurant_id is null
     or p_bottle_id is null
     or p_expected_opened_at is null then
    raise exception using
      errcode = '22023',
      message =
        'restaurant_id, bottle_id, and expected_opened_at are required';
  end if;

  if not public.is_member_with_role(p_restaurant_id, 'staff') then
    raise exception using
      errcode = '42501',
      message = 'forbidden';
  end if;

  if p_idempotency_key is null and p_request_hash is not null then
    raise exception using
      errcode = '22023',
      message = 'request hash requires an idempotency key';
  end if;

  if p_idempotency_key is not null then
    if char_length(p_idempotency_key) not between 8 and 128
       or p_idempotency_key !~ '^[A-Za-z0-9_-]+$' then
      raise exception using
        errcode = '22023',
        message = 'invalid idempotency key';
    end if;

    if p_request_hash is null
       or p_request_hash !~ '^[0-9a-f]{64}$' then
      raise exception using
        errcode = '22023',
        message = 'invalid request hash';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        v_user_id::text || ':' || p_idempotency_key,
        0
      )
    );

    loop
      select *
      into v_claim
      from public.api_idempotency
      where api_idempotency.user_id = v_user_id
        and api_idempotency.idempotency_key = p_idempotency_key
      for update;

      if found then
        if v_claim.restaurant_id <> p_restaurant_id
           or v_claim.operation_id
                <> 'api:POST:/api/open-bottles/{param}/close'
           or v_claim.request_hash <> p_request_hash then
          return query
          select
            'idempotency_key_reused'::text,
            409,
            jsonb_build_object(
              'error',
              jsonb_build_object(
                'code', 'idempotency_key_reused',
                'message',
                'This Idempotency-Key was already used for a different request.'
              )
            ),
            false;
          return;
        end if;

        if v_claim.updated_at
             < clock_timestamp() - interval '24 hours' then
          return query
          select
            'idempotency_key_expired'::text,
            409,
            jsonb_build_object(
              'error',
              jsonb_build_object(
                'code', 'idempotency_key_expired',
                'message', 'This Idempotency-Key has expired.'
              )
            ),
            false;
          return;
        end if;

        if v_claim.state = 'completed' then
          return query
          select
            'replay'::text,
            v_claim.response_status,
            v_claim.response_body,
            true;
          return;
        end if;

        if v_claim.state = 'failed_unknown' then
          return query
          select
            'idempotency_outcome_unknown'::text,
            409,
            jsonb_build_object(
              'error',
              jsonb_build_object(
                'code', 'idempotency_outcome_unknown',
                'message',
                'The original request outcome is unknown and will not be retried.'
              )
            ),
            false;
          return;
        end if;

        return query
        select
          'idempotency_in_progress'::text,
          409,
          jsonb_build_object(
            'error',
            jsonb_build_object(
              'code', 'idempotency_in_progress',
              'message',
              'A request with this Idempotency-Key is still in progress.'
            )
          ),
          false;
        return;
      end if;

      insert into public.api_idempotency (
        restaurant_id,
        user_id,
        operation_id,
        idempotency_key,
        request_hash
      ) values (
        p_restaurant_id,
        v_user_id,
        'api:POST:/api/open-bottles/{param}/close',
        p_idempotency_key,
        p_request_hash
      )
      on conflict (user_id, idempotency_key) do nothing;

      if found then
        exit;
      end if;
    end loop;
  end if;

  -- Discover the tenant-scoped parent, then take locks in the manual bottle
  -- lifecycle order: wine first, exact bottle second. The exact bottle is
  -- re-read under lock before any generation or closed-state decision.
  select open_bottles.wine_id
  into v_wine_id
  from public.open_bottles
  where open_bottles.id = p_bottle_id
    and open_bottles.restaurant_id = p_restaurant_id;

  if not found then
    v_outcome := 'not_found';
    v_status := 404;
    v_body := jsonb_build_object(
      'error',
      jsonb_build_object(
        'code', 'not_found',
        'message', 'Bottle not found.'
      )
    );
  else
    select wines.id
    into v_wine_id
    from public.wines
    where wines.id = v_wine_id
      and wines.restaurant_id = p_restaurant_id
    for update;

    if not found then
      v_outcome := 'not_found';
      v_status := 404;
      v_body := jsonb_build_object(
        'error',
        jsonb_build_object(
          'code', 'not_found',
          'message', 'Bottle not found.'
        )
      );
    else
      select *
      into v_bottle
      from public.open_bottles
      where open_bottles.id = p_bottle_id
        and open_bottles.wine_id = v_wine_id
        and open_bottles.restaurant_id = p_restaurant_id
      for update;

      if not found then
        v_outcome := 'not_found';
        v_status := 404;
        v_body := jsonb_build_object(
          'error',
          jsonb_build_object(
            'code', 'not_found',
            'message', 'Bottle not found.'
          )
        );
      elsif v_bottle.opened_at <> p_expected_opened_at then
        v_outcome := 'stale_open_bottle';
        v_status := 409;
        v_body := jsonb_build_object(
          'error',
          jsonb_build_object(
            'code', 'stale_open_bottle',
            'message',
            'This bottle was reopened after the page loaded. Refresh and try again.'
          )
        );
      elsif v_bottle.closed_at is not null then
        v_outcome := 'already_closed';
        v_status := 409;
        v_body := jsonb_build_object(
          'error',
          jsonb_build_object(
            'code', 'already_closed',
            'message', 'Bottle is already closed.'
          )
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
        ) values (
          v_bottle.wine_id,
          p_restaurant_id,
          v_bottle.remaining_ml,
          'spill',
          v_user_id,
          'Bottle closed (discard remaining)',
          v_bottle.id
        );

        select *
        into v_bottle
        from public.open_bottles
        where open_bottles.id = p_bottle_id
          and open_bottles.wine_id = v_wine_id
          and open_bottles.restaurant_id = p_restaurant_id;

        if not found
           or v_bottle.remaining_ml <> 0
           or v_bottle.closed_at is null then
          raise exception using
            errcode = '40001',
            message = 'close bottle trigger returned an invalid state';
        end if;

        v_outcome := 'closed';
        v_status := 200;
        v_body := jsonb_build_object(
          'closed',
          jsonb_build_object(
            'id', v_bottle.id,
            'wine_id', v_bottle.wine_id,
            'closed_at', v_bottle.closed_at
          )
        );
      end if;
    end if;
  end if;

  if p_idempotency_key is not null then
    v_now := clock_timestamp();
    update public.api_idempotency
    set state = 'completed',
        response_status = v_status,
        response_headers = '{}'::jsonb,
        response_body = v_body,
        updated_at = v_now,
        completed_at = v_now
    where api_idempotency.restaurant_id = p_restaurant_id
      and api_idempotency.user_id = v_user_id
      and api_idempotency.operation_id
            = 'api:POST:/api/open-bottles/{param}/close'
      and api_idempotency.idempotency_key = p_idempotency_key
      and api_idempotency.request_hash = p_request_hash
      and api_idempotency.state = 'in_progress';

    if not found then
      raise exception using
        errcode = '40001',
        message = 'idempotency completion changed concurrently';
    end if;
  end if;

  return query
  select v_outcome, v_status, v_body, false;
end;
$$;

revoke all on function public.close_open_bottle_idempotent(
  uuid,
  uuid,
  timestamptz,
  text,
  text
) from public;
revoke all on function public.close_open_bottle_idempotent(
  uuid,
  uuid,
  timestamptz,
  text,
  text
) from anon;
grant execute on function public.close_open_bottle_idempotent(
  uuid,
  uuid,
  timestamptz,
  text,
  text
) to authenticated;

comment on function public.close_open_bottle_idempotent(
  uuid,
  uuid,
  timestamptz,
  text,
  text
) is
  'Atomically closes one exact open-bottle generation and stores or replays its response.';

-- === 0060_record_pour_idempotency.sql ===
-- TER-020D09 — bind pour idempotency and the canonical record_pour mutation
-- to one PostgreSQL transaction.
--
-- record_pour already owns the complete pour/open/overage business
-- transaction. This boundary adds a caller-scoped idempotency claim, stores
-- the exact API response, and invokes record_pour directly. Both functions are
-- SECURITY DEFINER and continue to derive the actor from auth.uid(); no dynamic
-- SQL or role switching changes the authenticated execution context.

create extension if not exists pgcrypto with schema extensions;

create or replace function public.record_pour_idempotent(
  p_restaurant_id uuid,
  p_wine_id uuid,
  p_ml int,
  p_kind text default 'pour',
  p_note text default null,
  p_idempotency_key text default null,
  p_request_hash text default null
) returns table (
  outcome text,
  response_status integer,
  response_body jsonb,
  replayed boolean,
  execution_started_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_claim public.api_idempotency%rowtype;
  v_open public.open_bottles%rowtype;
  v_note text := nullif(btrim(p_note), '');
  v_identity text;
  v_request_hash text;
  v_message text;
  v_outcome text;
  v_body jsonb;
  v_status integer;
  v_now timestamptz;
  v_started_at timestamptz := now();
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication required';
  end if;

  if p_restaurant_id is null or p_wine_id is null then
    raise exception using
      errcode = '22023',
      message = 'restaurant_id and wine_id are required';
  end if;

  if not public.is_member_with_role(p_restaurant_id, 'staff') then
    raise exception using
      errcode = '42501',
      message = 'forbidden';
  end if;

  if p_ml is null or p_ml <= 0 or p_ml > 2000 then
    raise exception using
      errcode = '22023',
      message = 'ml must be between 1 and 2000';
  end if;

  if p_kind is null or p_kind not in ('pour', 'spill') then
    raise exception using
      errcode = '22023',
      message = 'kind must be pour or spill';
  end if;

  if v_note is not null and char_length(v_note) > 500 then
    raise exception using
      errcode = '22023',
      message = 'note must not exceed 500 characters';
  end if;

  -- Match createIdempotencyRequestHash's sorted canonical JSON and
  -- length-prefixed SHA-256 framing. The database recomputes this value so a
  -- direct authenticated RPC caller cannot bind one key to a dishonest hash.
  v_identity :=
    '{"kind":' || pg_catalog.to_json(p_kind)::text ||
    ',"ml":' || p_ml::text ||
    ',"note":' || coalesce(pg_catalog.to_json(v_note)::text, 'null') ||
    ',"wine_id":' || pg_catalog.to_json(p_wine_id::text)::text || '}';
  v_request_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.int8send(
        pg_catalog.octet_length(
          pg_catalog.convert_to(v_identity, 'UTF8')
        )::bigint
      ) || pg_catalog.convert_to(v_identity, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  if p_idempotency_key is null and p_request_hash is not null then
    raise exception using
      errcode = '22023',
      message = 'request hash requires an idempotency key';
  end if;

  if p_idempotency_key is not null then
    if char_length(p_idempotency_key) not between 8 and 128
       or p_idempotency_key !~ '^[A-Za-z0-9_-]+$' then
      raise exception using
        errcode = '22023',
        message = 'invalid idempotency key';
    end if;

    if p_request_hash is null
       or p_request_hash !~ '^[0-9a-f]{64}$' then
      raise exception using
        errcode = '22023',
        message = 'invalid request hash';
    end if;

    if p_request_hash <> v_request_hash then
      raise exception using
        errcode = '22023',
        message = 'request hash does not match the canonical pour identity';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        v_user_id::text || ':' || p_idempotency_key,
        0
      )
    );

    loop
      select *
      into v_claim
      from public.api_idempotency
      where api_idempotency.user_id = v_user_id
        and api_idempotency.idempotency_key = p_idempotency_key
      for update;

      if found then
        if v_claim.restaurant_id <> p_restaurant_id
           or v_claim.operation_id <> 'api:POST:/api/pour'
           or v_claim.request_hash <> v_request_hash then
          return query
          select
            'idempotency_key_reused'::text,
            409,
            jsonb_build_object(
              'error',
              jsonb_build_object(
                'code', 'idempotency_key_reused',
                'message',
                'This Idempotency-Key was already used for a different request.'
              )
            ),
            false,
            v_claim.created_at;
          return;
        end if;

        if v_claim.updated_at
             < clock_timestamp() - interval '24 hours' then
          return query
          select
            'idempotency_key_expired'::text,
            409,
            jsonb_build_object(
              'error',
              jsonb_build_object(
                'code', 'idempotency_key_expired',
                'message', 'This Idempotency-Key has expired.'
              )
            ),
            false,
            v_claim.created_at;
          return;
        end if;

        if v_claim.state = 'completed' then
          return query
          select
            'replay'::text,
            v_claim.response_status,
            v_claim.response_body,
            true,
            v_claim.created_at;
          return;
        end if;

        if v_claim.state = 'failed_unknown' then
          return query
          select
            'idempotency_outcome_unknown'::text,
            409,
            jsonb_build_object(
              'error',
              jsonb_build_object(
                'code', 'idempotency_outcome_unknown',
                'message',
                'The original request outcome is unknown and will not be retried.'
              )
            ),
            false,
            v_claim.created_at;
          return;
        end if;

        return query
        select
          'idempotency_in_progress'::text,
          409,
          jsonb_build_object(
            'error',
            jsonb_build_object(
              'code', 'idempotency_in_progress',
              'message',
              'A request with this Idempotency-Key is still in progress.'
            )
          ),
          false,
          v_claim.created_at;
        return;
      end if;

      insert into public.api_idempotency (
        restaurant_id,
        user_id,
        operation_id,
        idempotency_key,
        request_hash
      ) values (
        p_restaurant_id,
        v_user_id,
        'api:POST:/api/pour',
        p_idempotency_key,
        v_request_hash
      )
      on conflict (user_id, idempotency_key) do nothing
      returning * into v_claim;

      if found then
        v_started_at := v_claim.created_at;
        exit;
      end if;
    end loop;
  end if;

  begin
    select *
    into v_open
    from public.record_pour(
      p_restaurant_id,
      p_wine_id,
      p_ml,
      p_kind,
      v_note
    );

    if not found or v_open.id is null or v_open.wine_id is null then
      raise exception using
        errcode = '40001',
        message = 'record pour command returned an invalid result';
    end if;

    v_outcome := 'poured';
    v_status := 200;
    v_body := jsonb_build_object('open_bottle', to_jsonb(v_open));
  exception
    when sqlstate 'P0001' then
      get stacked diagnostics v_message = message_text;

      if v_message = 'TERROIR_OUT_OF_STOCK' then
        v_outcome := 'no_inventory';
        v_status := 409;
        v_body := jsonb_build_object(
          'error',
          jsonb_build_object(
            'code', 'no_inventory',
            'message', 'No inventory available.'
          )
        );
      elsif btrim(lower(v_message)) = 'wine not found' then
        v_outcome := 'not_found';
        v_status := 404;
        v_body := jsonb_build_object(
          'error',
          jsonb_build_object(
            'code', 'not_found',
            'message', 'Wine not found.'
          )
        );
      else
        raise;
      end if;
  end;

  if p_idempotency_key is not null then
    v_now := clock_timestamp();
    update public.api_idempotency
    set state = 'completed',
        response_status = v_status,
        response_headers = '{}'::jsonb,
        response_body = v_body,
        updated_at = v_now,
        completed_at = v_now
    where api_idempotency.restaurant_id = p_restaurant_id
      and api_idempotency.user_id = v_user_id
      and api_idempotency.operation_id = 'api:POST:/api/pour'
      and api_idempotency.idempotency_key = p_idempotency_key
      and api_idempotency.request_hash = v_request_hash
      and api_idempotency.state = 'in_progress';

    if not found then
      raise exception using
        errcode = '40001',
        message = 'idempotency completion changed concurrently';
    end if;
  end if;

  return query
  select v_outcome, v_status, v_body, false, v_started_at;
end;
$$;

revoke all on function public.record_pour_idempotent(
  uuid,
  uuid,
  int,
  text,
  text,
  text,
  text
) from public;
revoke all on function public.record_pour_idempotent(
  uuid,
  uuid,
  int,
  text,
  text,
  text,
  text
) from anon;
grant execute on function public.record_pour_idempotent(
  uuid,
  uuid,
  int,
  text,
  text,
  text,
  text
) to authenticated;

comment on function public.record_pour_idempotent(
  uuid,
  uuid,
  int,
  text,
  text,
  text,
  text
) is
  'Atomically records a pour and stores or replays its exact keyed API response.';

-- === 0061_undo_last_pour_idempotency.sql ===
-- TER-020D10 — bind pour-undo idempotency and the canonical
-- undo_last_pour mutation to one PostgreSQL transaction.
--
-- undo_last_pour already owns the complete event deletion, bottle restore,
-- and availability-event transaction. This boundary adds a caller-scoped
-- idempotency claim, invokes that hardened RPC without changing the
-- authenticated execution context, and stores the exact API response before
-- the outer statement commits.

create extension if not exists pgcrypto with schema extensions;

-- 0050 added an AFTER DELETE reversal trigger, but 0054 restored the older
-- undo body that also increased remaining_ml before deleting the event. That
-- doubled every restoration. Keep the canonical mutation trigger-driven:
-- lock the target event and bottle, abort if the linked bottle invariant is
-- broken, then let the single event deletion reverse the pour exactly once.
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
  order by occurred_at desc, id desc
  limit 1
  for update;

  if not found then
    raise exception 'no recent pour to undo' using errcode = 'P0001';
  end if;

  select * into v_current
  from public.open_bottles
  where id = v_event.open_bottle_id
    and wine_id = p_wine_id
    and restaurant_id = p_restaurant_id
  for update;

  if not found then
    raise exception using
      errcode = '40001',
      message = 'undo target bottle invariant violated';
  end if;

  -- pour_events_delete_trigger is the one authority that restores ml and
  -- clears closed_at. Do not update remaining_ml separately here.
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
  where id = v_event.open_bottle_id
    and wine_id = p_wine_id
    and restaurant_id = p_restaurant_id;
  return v_current;
end;
$$;

revoke all on function public.undo_last_pour(uuid, uuid) from public;
revoke all on function public.undo_last_pour(uuid, uuid) from anon;
grant execute on function public.undo_last_pour(uuid, uuid) to authenticated;

create or replace function public.undo_last_pour_idempotent(
  p_restaurant_id uuid,
  p_wine_id uuid,
  p_idempotency_key text default null,
  p_request_hash text default null
) returns table (
  outcome text,
  response_status integer,
  response_body jsonb,
  replayed boolean,
  execution_started_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_claim public.api_idempotency%rowtype;
  v_open public.open_bottles%rowtype;
  v_identity text;
  v_request_hash text;
  v_message text;
  v_outcome text;
  v_body jsonb;
  v_status integer;
  v_now timestamptz;
  v_started_at timestamptz := now();
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication required';
  end if;

  if p_restaurant_id is null or p_wine_id is null then
    raise exception using
      errcode = '22023',
      message = 'restaurant_id and wine_id are required';
  end if;

  if not public.is_member_with_role(p_restaurant_id, 'staff') then
    raise exception using
      errcode = '42501',
      message = 'forbidden';
  end if;

  -- Match createIdempotencyRequestHash's sorted canonical JSON and
  -- length-prefixed SHA-256 framing. PostgreSQL's uuid text representation is
  -- lowercase, so semantically identical UUID casing has one request identity.
  -- Recomputing this value prevents direct authenticated RPC callers from
  -- binding a key to a dishonest caller-supplied hash.
  v_identity :=
    '{"wine_id":' ||
    pg_catalog.to_json(p_wine_id::text)::text ||
    '}';
  v_request_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.int8send(
        pg_catalog.octet_length(
          pg_catalog.convert_to(v_identity, 'UTF8')
        )::bigint
      ) || pg_catalog.convert_to(v_identity, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  if p_idempotency_key is null and p_request_hash is not null then
    raise exception using
      errcode = '22023',
      message = 'request hash requires an idempotency key';
  end if;

  if p_idempotency_key is not null then
    if char_length(p_idempotency_key) not between 8 and 128
       or p_idempotency_key !~ '^[A-Za-z0-9_-]+$' then
      raise exception using
        errcode = '22023',
        message = 'invalid idempotency key';
    end if;

    if p_request_hash is null
       or p_request_hash !~ '^[0-9a-f]{64}$' then
      raise exception using
        errcode = '22023',
        message = 'invalid request hash';
    end if;

    if p_request_hash <> v_request_hash then
      raise exception using
        errcode = '22023',
        message = 'request hash does not match the canonical undo identity';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        v_user_id::text || ':' || p_idempotency_key,
        0
      )
    );

    loop
      select *
      into v_claim
      from public.api_idempotency
      where api_idempotency.user_id = v_user_id
        and api_idempotency.idempotency_key = p_idempotency_key
      for update;

      if found then
        if v_claim.restaurant_id <> p_restaurant_id
           or v_claim.operation_id <> 'api:POST:/api/pour/undo'
           or v_claim.request_hash <> v_request_hash then
          return query
          select
            'idempotency_key_reused'::text,
            409,
            jsonb_build_object(
              'error',
              jsonb_build_object(
                'code', 'idempotency_key_reused',
                'message',
                'This Idempotency-Key was already used for a different request.'
              )
            ),
            false,
            v_claim.created_at;
          return;
        end if;

        if v_claim.updated_at
             < clock_timestamp() - interval '24 hours' then
          return query
          select
            'idempotency_key_expired'::text,
            409,
            jsonb_build_object(
              'error',
              jsonb_build_object(
                'code', 'idempotency_key_expired',
                'message', 'This Idempotency-Key has expired.'
              )
            ),
            false,
            v_claim.created_at;
          return;
        end if;

        if v_claim.state = 'completed' then
          return query
          select
            'replay'::text,
            v_claim.response_status,
            v_claim.response_body,
            true,
            v_claim.created_at;
          return;
        end if;

        if v_claim.state = 'failed_unknown' then
          return query
          select
            'idempotency_outcome_unknown'::text,
            409,
            jsonb_build_object(
              'error',
              jsonb_build_object(
                'code', 'idempotency_outcome_unknown',
                'message',
                'The original request outcome is unknown and will not be retried.'
              )
            ),
            false,
            v_claim.created_at;
          return;
        end if;

        return query
        select
          'idempotency_in_progress'::text,
          409,
          jsonb_build_object(
            'error',
            jsonb_build_object(
              'code', 'idempotency_in_progress',
              'message',
              'A request with this Idempotency-Key is still in progress.'
            )
          ),
          false,
          v_claim.created_at;
        return;
      end if;

      insert into public.api_idempotency (
        restaurant_id,
        user_id,
        operation_id,
        idempotency_key,
        request_hash
      ) values (
        p_restaurant_id,
        v_user_id,
        'api:POST:/api/pour/undo',
        p_idempotency_key,
        v_request_hash
      )
      on conflict (user_id, idempotency_key) do nothing
      returning * into v_claim;

      if found then
        v_started_at := v_claim.created_at;
        exit;
      end if;
    end loop;
  end if;

  begin
    select *
    into v_open
    from public.undo_last_pour(
      p_restaurant_id,
      p_wine_id
    );

    if not found
       or v_open.id is null
       or v_open.wine_id is null
       or v_open.restaurant_id is null
       or v_open.remaining_ml is null then
      raise exception using
        errcode = '40001',
        message = 'undo last pour command returned an invalid result';
    end if;

    v_outcome := 'undone';
    v_status := 200;
    v_body := jsonb_build_object('open_bottle', to_jsonb(v_open));
  exception
    when sqlstate 'P0001' then
      get stacked diagnostics v_message = message_text;

      if btrim(lower(v_message)) in (
        'no recent pour to undo',
        'wine not found'
      ) then
        v_outcome := 'not_found';
        v_status := 404;
        v_body := jsonb_build_object(
          'error',
          jsonb_build_object(
            'code', 'not_found',
            'message', 'Pour to undo not found.'
          )
        );
      else
        raise;
      end if;
  end;

  if p_idempotency_key is not null then
    v_now := clock_timestamp();
    update public.api_idempotency
    set state = 'completed',
        response_status = v_status,
        response_headers = '{}'::jsonb,
        response_body = v_body,
        updated_at = v_now,
        completed_at = v_now
    where api_idempotency.restaurant_id = p_restaurant_id
      and api_idempotency.user_id = v_user_id
      and api_idempotency.operation_id = 'api:POST:/api/pour/undo'
      and api_idempotency.idempotency_key = p_idempotency_key
      and api_idempotency.request_hash = v_request_hash
      and api_idempotency.state = 'in_progress';

    if not found then
      raise exception using
        errcode = '40001',
        message = 'idempotency completion changed concurrently';
    end if;
  end if;

  return query
  select v_outcome, v_status, v_body, false, v_started_at;
end;
$$;

revoke all on function public.undo_last_pour_idempotent(
  uuid,
  uuid,
  text,
  text
) from public;
revoke all on function public.undo_last_pour_idempotent(
  uuid,
  uuid,
  text,
  text
) from anon;
grant execute on function public.undo_last_pour_idempotent(
  uuid,
  uuid,
  text,
  text
) to authenticated;

comment on function public.undo_last_pour_idempotent(
  uuid,
  uuid,
  text,
  text
) is
  'Atomically undoes the latest pour and stores or replays its exact keyed API response.';

-- === 0062_reconcile_idempotency.sql ===
-- TER-020D11 — atomically reconcile an ordered batch and store or replay the
-- exact route response.
--
-- The API validates and normalizes every entry before this boundary. The
-- database independently reconstructs the route's canonical, length-framed
-- SHA-256 identity so a caller-supplied hash cannot substitute a different
-- batch. Claim, manager-only batch execution, deterministic error mapping,
-- and completion are one PostgreSQL transaction.

create extension if not exists pgcrypto with schema extensions;

create or replace function public.reconcile_open_bottles_idempotent(
  p_restaurant_id uuid,
  p_entries jsonb,
  p_idempotency_key text default null,
  p_request_hash text default null
) returns table (
  outcome text,
  response_status integer,
  response_body jsonb,
  replayed boolean,
  execution_started_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_claim public.api_idempotency%rowtype;
  v_entry jsonb;
  v_normalized_entry jsonb;
  v_normalized_entries jsonb := '[]'::jsonb;
  v_canonical_entry text;
  v_canonical_entries text := '';
  v_canonical_body text;
  v_computed_hash text;
  v_wine_id uuid;
  v_remaining_ml integer;
  v_note text;
  v_has_note boolean;
  v_entry_count integer;
  v_updated integer;
  v_body jsonb;
  v_status integer;
  v_outcome text;
  v_now timestamptz;
  v_error_message text;
  v_started_at timestamptz := now();
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication required';
  end if;

  if p_restaurant_id is null then
    raise exception using
      errcode = '22023',
      message = 'restaurant_id is required';
  end if;

  if not public.is_member_with_role(p_restaurant_id, 'manager') then
    raise exception using
      errcode = '42501',
      message = 'forbidden';
  end if;

  if jsonb_typeof(p_entries) <> 'array' then
    raise exception using
      errcode = '22023',
      message = 'entries must be a JSON array';
  end if;

  v_entry_count := jsonb_array_length(p_entries);
  if v_entry_count not between 1 and 100 then
    raise exception using
      errcode = '22023',
      message = 'entries must contain between 1 and 100 items';
  end if;

  -- Rebuild exactly the canonical JSON that createIdempotencyRequestHash()
  -- receives at the route. Array order and duplicates are deliberately kept.
  for v_entry in
    select value
    from jsonb_array_elements(p_entries)
  loop
    if jsonb_typeof(v_entry) <> 'object'
       or not (v_entry ? 'wine_id')
       or not (v_entry ? 'new_remaining_ml')
       or jsonb_typeof(v_entry -> 'wine_id') <> 'string'
       or jsonb_typeof(v_entry -> 'new_remaining_ml') <> 'number'
       or (
         v_entry ? 'note'
         and jsonb_typeof(v_entry -> 'note') <> 'string'
       )
       or exists (
         select 1
         from jsonb_object_keys(v_entry) as entry_key
         where entry_key not in ('wine_id', 'new_remaining_ml', 'note')
       ) then
      raise exception using
        errcode = '22023',
        message = 'invalid reconcile entry';
    end if;

    begin
      v_wine_id := (v_entry ->> 'wine_id')::uuid;
      if (v_entry ->> 'new_remaining_ml')::numeric
           <> trunc((v_entry ->> 'new_remaining_ml')::numeric) then
        raise exception using
          errcode = '22023',
          message = 'new_remaining_ml must be an integer';
      end if;
      v_remaining_ml := (v_entry ->> 'new_remaining_ml')::integer;
    exception
      when invalid_text_representation or numeric_value_out_of_range then
        raise exception using
          errcode = '22023',
          message = 'invalid reconcile entry';
    end;

    if v_remaining_ml not between 0 and 20000 then
      raise exception using
        errcode = '22023',
        message = 'new_remaining_ml is outside the accepted range';
    end if;

    v_has_note := v_entry ? 'note';
    v_note := case
      when v_has_note then regexp_replace(
        v_entry ->> 'note',
        '^\s+|\s+$',
        '',
        'g'
      )
      else null
    end;
    if v_has_note and char_length(v_note) > 500 then
      raise exception using
        errcode = '22023',
        message = 'note exceeds 500 characters';
    end if;

    v_normalized_entry := jsonb_build_object(
      'wine_id', lower(v_wine_id::text),
      'new_remaining_ml', v_remaining_ml
    );
    v_canonical_entry :=
      '{"new_remaining_ml":' || v_remaining_ml::text;

    if v_has_note then
      v_normalized_entry :=
        v_normalized_entry || jsonb_build_object('note', v_note);
      v_canonical_entry :=
        v_canonical_entry || ',"note":' || to_jsonb(v_note)::text;
    end if;

    v_canonical_entry :=
      v_canonical_entry
      || ',"wine_id":'
      || to_jsonb(lower(v_wine_id::text))::text
      || '}';
    v_canonical_entries :=
      v_canonical_entries
      || case when v_canonical_entries = '' then '' else ',' end
      || v_canonical_entry;
    v_normalized_entries :=
      v_normalized_entries || jsonb_build_array(v_normalized_entry);
  end loop;

  v_canonical_body := '{"entries":[' || v_canonical_entries || ']}';
  v_computed_hash := encode(
    extensions.digest(
      decode(
        lpad(to_hex(octet_length(convert_to(v_canonical_body, 'UTF8'))), 16, '0'),
        'hex'
      ) || convert_to(v_canonical_body, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  if p_idempotency_key is null and p_request_hash is not null then
    raise exception using
      errcode = '22023',
      message = 'request hash requires an idempotency key';
  end if;

  if p_idempotency_key is not null then
    if char_length(p_idempotency_key) not between 8 and 128
       or p_idempotency_key !~ '^[A-Za-z0-9_-]+$' then
      raise exception using
        errcode = '22023',
        message = 'invalid idempotency key';
    end if;

    if p_request_hash is null
       or p_request_hash !~ '^[0-9a-f]{64}$'
       or p_request_hash <> v_computed_hash then
      raise exception using
        errcode = '22023',
        message = 'invalid request hash';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        v_user_id::text || ':' || p_idempotency_key,
        0
      )
    );

    loop
      select *
      into v_claim
      from public.api_idempotency
      where api_idempotency.user_id = v_user_id
        and api_idempotency.idempotency_key = p_idempotency_key
      for update;

      if found then
        if v_claim.restaurant_id <> p_restaurant_id
           or v_claim.operation_id <> 'api:POST:/api/reconcile'
           or v_claim.request_hash <> v_computed_hash then
          return query
          select
            'idempotency_key_reused'::text,
            409,
            jsonb_build_object(
              'error',
              jsonb_build_object(
                'code', 'idempotency_key_reused',
                'message',
                'This Idempotency-Key was already used for a different request.'
              )
            ),
            false,
            v_claim.created_at;
          return;
        end if;

        if v_claim.updated_at
             < clock_timestamp() - interval '24 hours' then
          return query
          select
            'idempotency_key_expired'::text,
            409,
            jsonb_build_object(
              'error',
              jsonb_build_object(
                'code', 'idempotency_key_expired',
                'message', 'This Idempotency-Key has expired.'
              )
            ),
            false,
            v_claim.created_at;
          return;
        end if;

        if v_claim.state = 'completed' then
          return query
          select
            'replay'::text,
            v_claim.response_status,
            v_claim.response_body,
            true,
            v_claim.created_at;
          return;
        end if;

        if v_claim.state = 'failed_unknown' then
          return query
          select
            'idempotency_outcome_unknown'::text,
            409,
            jsonb_build_object(
              'error',
              jsonb_build_object(
                'code', 'idempotency_outcome_unknown',
                'message',
                'The original request outcome is unknown and will not be retried.'
              )
            ),
            false,
            v_claim.created_at;
          return;
        end if;

        return query
        select
          'idempotency_in_progress'::text,
          409,
          jsonb_build_object(
            'error',
            jsonb_build_object(
              'code', 'idempotency_in_progress',
              'message',
              'A request with this Idempotency-Key is still in progress.'
            )
          ),
          false,
          v_claim.created_at;
        return;
      end if;

      insert into public.api_idempotency (
        restaurant_id,
        user_id,
        operation_id,
        idempotency_key,
        request_hash
      ) values (
        p_restaurant_id,
        v_user_id,
        'api:POST:/api/reconcile',
        p_idempotency_key,
        v_computed_hash
      )
      on conflict (user_id, idempotency_key) do nothing
      returning * into v_claim;

      if found then
        v_started_at := v_claim.created_at;
        exit;
      end if;
    end loop;
  end if;

  begin
    v_updated := public.reconcile_open_bottles_batch(
      p_restaurant_id,
      v_normalized_entries
    );
    v_outcome := 'reconciled';
    v_status := 200;
    v_body := jsonb_build_object('updated', v_updated);
  exception
    when sqlstate 'P0002' then
      v_outcome := 'exceeds_size';
      v_status := 400;
      v_body := jsonb_build_object(
        'error',
        jsonb_build_object(
          'code', 'EXCEEDS_SIZE',
          'message', 'new_remaining_ml exceeds bottle size.'
        )
      );
    when sqlstate 'P0001' then
      get stacked diagnostics v_error_message = message_text;
      if lower(v_error_message) not in (
        'wine not found',
        'no open bottle for this wine'
      ) then
        raise;
      end if;
      v_outcome := 'not_found';
      v_status := 404;
      v_body := jsonb_build_object(
        'error',
        jsonb_build_object(
          'code', 'not_found',
          'message', 'Open bottle not found.'
        )
      );
  end;

  if p_idempotency_key is not null then
    v_now := clock_timestamp();
    update public.api_idempotency
    set state = 'completed',
        response_status = v_status,
        response_headers = '{}'::jsonb,
        response_body = v_body,
        updated_at = v_now,
        completed_at = v_now
    where api_idempotency.restaurant_id = p_restaurant_id
      and api_idempotency.user_id = v_user_id
      and api_idempotency.operation_id = 'api:POST:/api/reconcile'
      and api_idempotency.idempotency_key = p_idempotency_key
      and api_idempotency.request_hash = v_computed_hash
      and api_idempotency.state = 'in_progress';

    if not found then
      raise exception using
        errcode = '40001',
        message = 'idempotency completion changed concurrently';
    end if;
  end if;

  return query
  select v_outcome, v_status, v_body, false, v_started_at;
end;
$$;

revoke all on function public.reconcile_open_bottles_idempotent(
  uuid,
  jsonb,
  text,
  text
) from public;
revoke all on function public.reconcile_open_bottles_idempotent(
  uuid,
  jsonb,
  text,
  text
) from anon;
grant execute on function public.reconcile_open_bottles_idempotent(
  uuid,
  jsonb,
  text,
  text
) to authenticated;

comment on function public.reconcile_open_bottles_idempotent(
  uuid,
  jsonb,
  text,
  text
) is
  'Atomically reconciles one ordered manager batch and stores or replays its exact response.';

-- === 0063_team_member_idempotency.sql ===
-- TER-020D13 — make team member role changes and removals atomic with their
-- caller-scoped idempotency records. Both commands serialize the restaurant's
-- membership set so concurrent owner changes cannot violate its invariants.

create extension if not exists pgcrypto with schema extensions;

create or replace function public.update_team_member_role_idempotent(
  p_restaurant_id uuid,
  p_member_id uuid,
  p_role public.membership_role,
  p_idempotency_key text default null,
  p_request_hash text default null
) returns table (
  outcome text,
  response_status integer,
  response_body jsonb,
  replayed boolean,
  execution_started_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_claim public.api_idempotency%rowtype;
  v_target public.memberships%rowtype;
  v_identity text;
  v_request_hash text;
  v_outcome text;
  v_body jsonb;
  v_status integer;
  v_now timestamptz;
  v_started_at timestamptz := now();
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication required';
  end if;

  if p_restaurant_id is null
     or p_member_id is null
     or p_role is null then
    raise exception using
      errcode = '22023',
      message = 'restaurant_id, member_id, and role are required';
  end if;

  if not public.is_member_with_role(p_restaurant_id, 'owner') then
    raise exception using
      errcode = '42501',
      message = 'forbidden';
  end if;

  -- createIdempotencyRequestHash({ id, role }) sorts these two keys and frames
  -- the UTF-8 canonical JSON with an eight-byte big-endian length.
  v_identity :=
    '{"id":' || pg_catalog.to_json(p_member_id::text)::text ||
    ',"role":' || pg_catalog.to_json(p_role::text)::text ||
    '}';
  v_request_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.int8send(
        pg_catalog.octet_length(
          pg_catalog.convert_to(v_identity, 'UTF8')
        )::bigint
      ) || pg_catalog.convert_to(v_identity, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  if p_idempotency_key is null and p_request_hash is not null then
    raise exception using
      errcode = '22023',
      message = 'request hash requires an idempotency key';
  end if;

  if p_idempotency_key is not null then
    if char_length(p_idempotency_key) not between 8 and 128
       or p_idempotency_key !~ '^[A-Za-z0-9_-]+$' then
      raise exception using
        errcode = '22023',
        message = 'invalid idempotency key';
    end if;

    if p_request_hash is null
       or p_request_hash !~ '^[0-9a-f]{64}$' then
      raise exception using
        errcode = '22023',
        message = 'invalid request hash';
    end if;

    if p_request_hash <> v_request_hash then
      raise exception using
        errcode = '22023',
        message = 'request hash does not match the canonical role identity';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        v_user_id::text || ':' || p_idempotency_key,
        0
      )
    );

    loop
      select *
      into v_claim
      from public.api_idempotency
      where api_idempotency.user_id = v_user_id
        and api_idempotency.idempotency_key = p_idempotency_key
      for update;

      if found then
        if v_claim.restaurant_id <> p_restaurant_id
           or v_claim.operation_id
                <> 'api:PATCH:/api/team/members/{param}'
           or v_claim.request_hash <> v_request_hash then
          return query
          select
            'idempotency_key_reused'::text,
            409,
            jsonb_build_object(
              'error',
              jsonb_build_object(
                'code', 'idempotency_key_reused',
                'message',
                'This Idempotency-Key was already used for a different request.'
              )
            ),
            false,
            v_claim.created_at;
          return;
        end if;

        if v_claim.updated_at
             < clock_timestamp() - interval '24 hours' then
          return query
          select
            'idempotency_key_expired'::text,
            409,
            jsonb_build_object(
              'error',
              jsonb_build_object(
                'code', 'idempotency_key_expired',
                'message', 'This Idempotency-Key has expired.'
              )
            ),
            false,
            v_claim.created_at;
          return;
        end if;

        if v_claim.state = 'completed' then
          return query
          select
            'replay'::text,
            v_claim.response_status,
            v_claim.response_body,
            true,
            v_claim.created_at;
          return;
        end if;

        if v_claim.state = 'failed_unknown' then
          return query
          select
            'idempotency_outcome_unknown'::text,
            409,
            jsonb_build_object(
              'error',
              jsonb_build_object(
                'code', 'idempotency_outcome_unknown',
                'message',
                'The original request outcome is unknown and will not be retried.'
              )
            ),
            false,
            v_claim.created_at;
          return;
        end if;

        return query
        select
          'idempotency_in_progress'::text,
          409,
          jsonb_build_object(
            'error',
            jsonb_build_object(
              'code', 'idempotency_in_progress',
              'message',
              'A request with this Idempotency-Key is still in progress.'
            )
          ),
          false,
          v_claim.created_at;
        return;
      end if;

      insert into public.api_idempotency (
        restaurant_id,
        user_id,
        operation_id,
        idempotency_key,
        request_hash
      ) values (
        p_restaurant_id,
        v_user_id,
        'api:PATCH:/api/team/members/{param}',
        p_idempotency_key,
        v_request_hash
      )
      on conflict (user_id, idempotency_key) do nothing
      returning * into v_claim;

      if found then
        v_started_at := v_claim.created_at;
        exit;
      end if;
    end loop;
  end if;

  -- Lock every membership in a stable order, then re-check the actor's owner
  -- role under that lock. Different keys and different owners therefore still
  -- share one serial membership-invariant boundary.
  perform 1
  from public.memberships
  where restaurant_id = p_restaurant_id
  order by id
  for update;

  if not exists (
    select 1
    from public.memberships
    where restaurant_id = p_restaurant_id
      and user_id = v_user_id
      and role = 'owner'
  ) then
    raise exception using
      errcode = '42501',
      message = 'forbidden';
  end if;

  select *
  into v_target
  from public.memberships
  where id = p_member_id
    and restaurant_id = p_restaurant_id;

  if not found then
    v_outcome := 'not_found';
    v_status := 404;
    v_body := jsonb_build_object(
      'error',
      jsonb_build_object(
        'code', 'not_found',
        'message', 'Member not found.'
      )
    );
  elsif v_target.role = 'owner'
        and p_role <> 'owner'
        and (
          select count(*)
          from public.memberships
          where restaurant_id = p_restaurant_id
            and role = 'owner'
        ) <= 1 then
    v_outcome := 'last_owner';
    v_status := 400;
    v_body := jsonb_build_object(
      'error',
      jsonb_build_object(
        'code', 'bad_request',
        'message', 'Cannot demote the last owner.'
      )
    );
  else
    update public.memberships
    set role = p_role
    where id = p_member_id
      and restaurant_id = p_restaurant_id;

    if not found then
      raise exception using
        errcode = '40001',
        message = 'member role target changed concurrently';
    end if;

    v_outcome := 'updated';
    v_status := 200;
    v_body := jsonb_build_object('success', true);
  end if;

  if p_idempotency_key is not null then
    v_now := clock_timestamp();
    update public.api_idempotency
    set state = 'completed',
        response_status = v_status,
        response_headers = '{}'::jsonb,
        response_body = v_body,
        updated_at = v_now,
        completed_at = v_now
    where api_idempotency.restaurant_id = p_restaurant_id
      and api_idempotency.user_id = v_user_id
      and api_idempotency.operation_id
            = 'api:PATCH:/api/team/members/{param}'
      and api_idempotency.idempotency_key = p_idempotency_key
      and api_idempotency.request_hash = v_request_hash
      and api_idempotency.state = 'in_progress';

    if not found then
      raise exception using
        errcode = '40001',
        message = 'idempotency completion changed concurrently';
    end if;
  end if;

  return query
  select v_outcome, v_status, v_body, false, v_started_at;
end;
$$;

revoke all on function public.update_team_member_role_idempotent(
  uuid,
  uuid,
  public.membership_role,
  text,
  text
) from public;
revoke all on function public.update_team_member_role_idempotent(
  uuid,
  uuid,
  public.membership_role,
  text,
  text
) from anon;
grant execute on function public.update_team_member_role_idempotent(
  uuid,
  uuid,
  public.membership_role,
  text,
  text
) to authenticated;

comment on function public.update_team_member_role_idempotent(
  uuid,
  uuid,
  public.membership_role,
  text,
  text
) is
  'Atomically changes one team member role and stores or replays its exact keyed API response.';

create or replace function public.remove_team_member_idempotent(
  p_restaurant_id uuid,
  p_member_id uuid,
  p_idempotency_key text default null,
  p_request_hash text default null
) returns table (
  outcome text,
  response_status integer,
  response_body jsonb,
  replayed boolean,
  execution_started_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_claim public.api_idempotency%rowtype;
  v_target public.memberships%rowtype;
  v_identity text;
  v_request_hash text;
  v_outcome text;
  v_body jsonb;
  v_status integer;
  v_now timestamptz;
  v_started_at timestamptz := now();
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication required';
  end if;

  if p_restaurant_id is null or p_member_id is null then
    raise exception using
      errcode = '22023',
      message = 'restaurant_id and member_id are required';
  end if;

  if not public.is_member_with_role(p_restaurant_id, 'owner') then
    raise exception using
      errcode = '42501',
      message = 'forbidden';
  end if;

  v_identity :=
    '{"id":' || pg_catalog.to_json(p_member_id::text)::text ||
    '}';
  v_request_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.int8send(
        pg_catalog.octet_length(
          pg_catalog.convert_to(v_identity, 'UTF8')
        )::bigint
      ) || pg_catalog.convert_to(v_identity, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  if p_idempotency_key is null and p_request_hash is not null then
    raise exception using
      errcode = '22023',
      message = 'request hash requires an idempotency key';
  end if;

  if p_idempotency_key is not null then
    if char_length(p_idempotency_key) not between 8 and 128
       or p_idempotency_key !~ '^[A-Za-z0-9_-]+$' then
      raise exception using
        errcode = '22023',
        message = 'invalid idempotency key';
    end if;

    if p_request_hash is null
       or p_request_hash !~ '^[0-9a-f]{64}$' then
      raise exception using
        errcode = '22023',
        message = 'invalid request hash';
    end if;

    if p_request_hash <> v_request_hash then
      raise exception using
        errcode = '22023',
        message = 'request hash does not match the canonical removal identity';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        v_user_id::text || ':' || p_idempotency_key,
        0
      )
    );

    loop
      select *
      into v_claim
      from public.api_idempotency
      where api_idempotency.user_id = v_user_id
        and api_idempotency.idempotency_key = p_idempotency_key
      for update;

      if found then
        if v_claim.restaurant_id <> p_restaurant_id
           or v_claim.operation_id
                <> 'api:DELETE:/api/team/members/{param}'
           or v_claim.request_hash <> v_request_hash then
          return query
          select
            'idempotency_key_reused'::text,
            409,
            jsonb_build_object(
              'error',
              jsonb_build_object(
                'code', 'idempotency_key_reused',
                'message',
                'This Idempotency-Key was already used for a different request.'
              )
            ),
            false,
            v_claim.created_at;
          return;
        end if;

        if v_claim.updated_at
             < clock_timestamp() - interval '24 hours' then
          return query
          select
            'idempotency_key_expired'::text,
            409,
            jsonb_build_object(
              'error',
              jsonb_build_object(
                'code', 'idempotency_key_expired',
                'message', 'This Idempotency-Key has expired.'
              )
            ),
            false,
            v_claim.created_at;
          return;
        end if;

        if v_claim.state = 'completed' then
          return query
          select
            'replay'::text,
            v_claim.response_status,
            v_claim.response_body,
            true,
            v_claim.created_at;
          return;
        end if;

        if v_claim.state = 'failed_unknown' then
          return query
          select
            'idempotency_outcome_unknown'::text,
            409,
            jsonb_build_object(
              'error',
              jsonb_build_object(
                'code', 'idempotency_outcome_unknown',
                'message',
                'The original request outcome is unknown and will not be retried.'
              )
            ),
            false,
            v_claim.created_at;
          return;
        end if;

        return query
        select
          'idempotency_in_progress'::text,
          409,
          jsonb_build_object(
            'error',
            jsonb_build_object(
              'code', 'idempotency_in_progress',
              'message',
              'A request with this Idempotency-Key is still in progress.'
            )
          ),
          false,
          v_claim.created_at;
        return;
      end if;

      insert into public.api_idempotency (
        restaurant_id,
        user_id,
        operation_id,
        idempotency_key,
        request_hash
      ) values (
        p_restaurant_id,
        v_user_id,
        'api:DELETE:/api/team/members/{param}',
        p_idempotency_key,
        v_request_hash
      )
      on conflict (user_id, idempotency_key) do nothing
      returning * into v_claim;

      if found then
        v_started_at := v_claim.created_at;
        exit;
      end if;
    end loop;
  end if;

  perform 1
  from public.memberships
  where restaurant_id = p_restaurant_id
  order by id
  for update;

  if not exists (
    select 1
    from public.memberships
    where restaurant_id = p_restaurant_id
      and user_id = v_user_id
      and role = 'owner'
  ) then
    raise exception using
      errcode = '42501',
      message = 'forbidden';
  end if;

  select *
  into v_target
  from public.memberships
  where id = p_member_id
    and restaurant_id = p_restaurant_id;

  if not found then
    v_outcome := 'not_found';
    v_status := 404;
    v_body := jsonb_build_object(
      'error',
      jsonb_build_object(
        'code', 'not_found',
        'message', 'Member not found.'
      )
    );
  elsif v_target.user_id = v_user_id then
    v_outcome := 'self_removal';
    v_status := 400;
    v_body := jsonb_build_object(
      'error',
      jsonb_build_object(
        'code', 'bad_request',
        'message', 'Cannot remove yourself.'
      )
    );
  else
    delete from public.memberships
    where id = p_member_id
      and restaurant_id = p_restaurant_id;

    if not found then
      raise exception using
        errcode = '40001',
        message = 'member removal target changed concurrently';
    end if;

    -- The actor was revalidated as an owner while the complete membership set
    -- was locked, and self-removal is forbidden. At least that owner remains.
    v_outcome := 'removed';
    v_status := 200;
    v_body := jsonb_build_object('success', true);
  end if;

  if p_idempotency_key is not null then
    v_now := clock_timestamp();
    update public.api_idempotency
    set state = 'completed',
        response_status = v_status,
        response_headers = '{}'::jsonb,
        response_body = v_body,
        updated_at = v_now,
        completed_at = v_now
    where api_idempotency.restaurant_id = p_restaurant_id
      and api_idempotency.user_id = v_user_id
      and api_idempotency.operation_id
            = 'api:DELETE:/api/team/members/{param}'
      and api_idempotency.idempotency_key = p_idempotency_key
      and api_idempotency.request_hash = v_request_hash
      and api_idempotency.state = 'in_progress';

    if not found then
      raise exception using
        errcode = '40001',
        message = 'idempotency completion changed concurrently';
    end if;
  end if;

  return query
  select v_outcome, v_status, v_body, false, v_started_at;
end;
$$;

revoke all on function public.remove_team_member_idempotent(
  uuid,
  uuid,
  text,
  text
) from public;
revoke all on function public.remove_team_member_idempotent(
  uuid,
  uuid,
  text,
  text
) from anon;
grant execute on function public.remove_team_member_idempotent(
  uuid,
  uuid,
  text,
  text
) to authenticated;

comment on function public.remove_team_member_idempotent(
  uuid,
  uuid,
  text,
  text
) is
  'Atomically removes one team member and stores or replays its exact keyed API response.';

-- === 0064_create_wine_list_item_idempotency.sql ===
-- TER-020D17 — atomically create a wine-list item and store its response.
--
-- A generic idempotency claim cannot make the business insert and response
-- completion one transaction. If completion is lost after the insert commits,
-- cleanup can eventually remove the unresolved claim and allow a duplicate
-- item. This dedicated boundary makes claim, section-serialized position
-- allocation, insert, and exact response storage one PostgreSQL transaction.

create or replace function public.create_wine_list_item_idempotent(
  p_restaurant_id uuid,
  p_section_id uuid,
  p_wine_id uuid,
  p_glass_price numeric default null,
  p_bottle_price numeric default null,
  p_name_override text default null,
  p_idempotency_key text default null,
  p_request_hash text default null
) returns table (
  outcome text,
  response_status integer,
  response_body jsonb,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_claim public.api_idempotency%rowtype;
  v_item_id uuid;
  v_next_position integer;
  v_body jsonb;
  v_status integer;
  v_now timestamptz;
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication required';
  end if;

  if p_restaurant_id is null
     or p_section_id is null
     or p_wine_id is null then
    raise exception using
      errcode = '22023',
      message = 'restaurant_id, section_id, and wine_id are required';
  end if;

  if not public.is_member_with_role(p_restaurant_id, 'manager') then
    raise exception using
      errcode = '42501',
      message = 'forbidden';
  end if;

  if p_glass_price is not null and p_glass_price < 0
     or p_bottle_price is not null and p_bottle_price < 0 then
    raise exception using
      errcode = '22023',
      message = 'prices must be nonnegative';
  end if;

  if p_idempotency_key is null and p_request_hash is not null then
    raise exception using
      errcode = '22023',
      message = 'request hash requires an idempotency key';
  end if;

  if p_idempotency_key is not null then
    if char_length(p_idempotency_key) not between 8 and 128
       or p_idempotency_key !~ '^[A-Za-z0-9_-]+$' then
      raise exception using
        errcode = '22023',
        message = 'invalid idempotency key';
    end if;

    if p_request_hash is null
       or p_request_hash !~ '^[0-9a-f]{64}$' then
      raise exception using
        errcode = '22023',
        message = 'invalid request hash';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        v_user_id::text || ':' || p_idempotency_key,
        0
      )
    );

    loop
      select *
      into v_claim
      from public.api_idempotency
      where api_idempotency.user_id = v_user_id
        and api_idempotency.idempotency_key = p_idempotency_key
      for update;

      if found then
        if v_claim.restaurant_id <> p_restaurant_id
           or v_claim.operation_id
                <> 'api:POST:/api/wine-list-items'
           or v_claim.request_hash <> p_request_hash then
          return query
          select
            'idempotency_key_reused'::text,
            409,
            jsonb_build_object(
              'error',
              jsonb_build_object(
                'code', 'idempotency_key_reused',
                'message',
                'This Idempotency-Key was already used for a different request.'
              )
            ),
            false;
          return;
        end if;

        if v_claim.updated_at
             < clock_timestamp() - interval '24 hours' then
          return query
          select
            'idempotency_key_expired'::text,
            409,
            jsonb_build_object(
              'error',
              jsonb_build_object(
                'code', 'idempotency_key_expired',
                'message', 'This Idempotency-Key has expired.'
              )
            ),
            false;
          return;
        end if;

        if v_claim.state = 'completed' then
          return query
          select
            'replay'::text,
            v_claim.response_status,
            v_claim.response_body,
            true;
          return;
        end if;

        if v_claim.state = 'failed_unknown' then
          return query
          select
            'idempotency_outcome_unknown'::text,
            409,
            jsonb_build_object(
              'error',
              jsonb_build_object(
                'code', 'idempotency_outcome_unknown',
                'message',
                'The original request outcome is unknown and will not be retried.'
              )
            ),
            false;
          return;
        end if;

        return query
        select
          'idempotency_in_progress'::text,
          409,
          jsonb_build_object(
            'error',
            jsonb_build_object(
              'code', 'idempotency_in_progress',
              'message',
              'A request with this Idempotency-Key is still in progress.'
            )
          ),
          false;
        return;
      end if;

      insert into public.api_idempotency (
        restaurant_id,
        user_id,
        operation_id,
        idempotency_key,
        request_hash
      ) values (
        p_restaurant_id,
        v_user_id,
        'api:POST:/api/wine-list-items',
        p_idempotency_key,
        p_request_hash
      )
      on conflict (user_id, idempotency_key) do nothing;

      if found then
        exit;
      end if;
    end loop;
  end if;

  -- Lock the owned section so concurrent creates allocate distinct positions.
  perform 1
  from public.wine_list_sections section
  join public.wine_lists list on list.id = section.wine_list_id
  where section.id = p_section_id
    and list.restaurant_id = p_restaurant_id
  for update of section;

  if not found then
    v_status := 404;
    v_body := jsonb_build_object(
      'error',
      jsonb_build_object(
        'code', 'not_found',
        'message', 'Section not found.'
      )
    );
    outcome := 'not_found';
  elsif not exists (
    select 1
    from public.wines wine
    where wine.id = p_wine_id
      and wine.restaurant_id = p_restaurant_id
  ) then
    v_status := 404;
    v_body := jsonb_build_object(
      'error',
      jsonb_build_object(
        'code', 'not_found',
        'message', 'Wine not found.'
      )
    );
    outcome := 'not_found';
  else
    select coalesce(max(item.position), -1) + 1
    into v_next_position
    from public.wine_list_items item
    where item.section_id = p_section_id;

    insert into public.wine_list_items (
      section_id,
      wine_id,
      position,
      glass_price,
      bottle_price,
      name_override
    ) values (
      p_section_id,
      p_wine_id,
      v_next_position,
      p_glass_price,
      p_bottle_price,
      p_name_override
    )
    returning id into v_item_id;

    v_status := 200;
    v_body := jsonb_build_object('id', v_item_id);
    outcome := 'created';
  end if;

  if p_idempotency_key is not null then
    v_now := clock_timestamp();
    update public.api_idempotency
    set state = 'completed',
        response_status = v_status,
        response_headers = '{}'::jsonb,
        response_body = v_body,
        updated_at = v_now,
        completed_at = v_now
    where api_idempotency.restaurant_id = p_restaurant_id
      and api_idempotency.user_id = v_user_id
      and api_idempotency.operation_id
            = 'api:POST:/api/wine-list-items'
      and api_idempotency.idempotency_key = p_idempotency_key
      and api_idempotency.request_hash = p_request_hash
      and api_idempotency.state = 'in_progress';

    if not found then
      raise exception using
        errcode = '40001',
        message = 'idempotency completion changed concurrently';
    end if;
  end if;

  return query
  select outcome, v_status, v_body, false;
end;
$$;

revoke all on function public.create_wine_list_item_idempotent(
  uuid,
  uuid,
  uuid,
  numeric,
  numeric,
  text,
  text,
  text
) from public;
revoke all on function public.create_wine_list_item_idempotent(
  uuid,
  uuid,
  uuid,
  numeric,
  numeric,
  text,
  text,
  text
) from anon;
grant execute on function public.create_wine_list_item_idempotent(
  uuid,
  uuid,
  uuid,
  numeric,
  numeric,
  text,
  text,
  text
) to authenticated;

comment on function public.create_wine_list_item_idempotent(
  uuid,
  uuid,
  uuid,
  numeric,
  numeric,
  text,
  text,
  text
) is
  'Atomically creates one wine-list item and stores or replays its exact keyed response.';

-- === 0065_invoice_scan_commit_idempotency.sql ===
-- Migration 0065 / TER-020D18 — commit one invoice scan and its idempotency response in the
-- same transaction. The scan row lock serializes commits while the shared
-- per-user key claim prevents a lost HTTP response from duplicating inventory.

create extension if not exists pgcrypto with schema extensions;

create or replace function public.commit_invoice_scan_idempotent(
  p_restaurant_id uuid,
  p_scan_id uuid,
  p_idempotency_key text default null,
  p_request_hash text default null
) returns table (
  outcome text,
  response_status integer,
  response_body jsonb,
  replayed boolean,
  wine_ids uuid[]
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_claim record;
  v_scan public.invoice_scans%rowtype;
  v_items jsonb;
  v_wines jsonb;
  v_wine_ids uuid[];
  v_wine_count integer;
  v_identity text;
  v_computed_hash text;
  v_body jsonb;
  v_completed boolean;
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication required';
  end if;

  if p_restaurant_id is null or p_scan_id is null then
    raise exception using
      errcode = '22023',
      message = 'restaurant_id and scan_id are required';
  end if;

  if not public.is_member_with_role(p_restaurant_id, 'staff') then
    raise exception using
      errcode = '42501',
      message = 'forbidden';
  end if;

  -- createIdempotencyRequestHash({ id }) sorts the single key and frames the
  -- UTF-8 canonical JSON with an eight-byte big-endian length.
  v_identity :=
    '{"id":' || pg_catalog.to_json(p_scan_id::text)::text || '}';
  v_computed_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.int8send(
        pg_catalog.octet_length(
          pg_catalog.convert_to(v_identity, 'UTF8')
        )::bigint
      ) || pg_catalog.convert_to(v_identity, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  if p_idempotency_key is null and p_request_hash is not null then
    raise exception using
      errcode = '22023',
      message = 'request hash requires an idempotency key';
  end if;

  if p_idempotency_key is not null then
    if p_request_hash is null or p_request_hash <> v_computed_hash then
      raise exception using
        errcode = '22023',
        message = 'request hash does not match the canonical scan identity';
    end if;

    select *
    into v_claim
    from public.claim_api_idempotency(
      p_restaurant_id,
      'api:POST:/api/scans/{param}/commit',
      p_idempotency_key,
      v_computed_hash
    );

    if v_claim.outcome = 'replay' then
      return query
      select
        'replay'::text,
        v_claim.response_status,
        v_claim.response_body,
        true,
        null::uuid[];
      return;
    elsif v_claim.outcome = 'in_progress' then
      return query
      select
        'idempotency_in_progress'::text,
        409,
        jsonb_build_object(
          'error',
          jsonb_build_object(
            'code', 'idempotency_in_progress',
            'message',
            'A request with this Idempotency-Key is still in progress.'
          )
        ),
        false,
        null::uuid[];
      return;
    elsif v_claim.outcome = 'mismatch' then
      return query
      select
        'idempotency_key_reused'::text,
        409,
        jsonb_build_object(
          'error',
          jsonb_build_object(
            'code', 'idempotency_key_reused',
            'message',
            'This Idempotency-Key was already used for a different request.'
          )
        ),
        false,
        null::uuid[];
      return;
    elsif v_claim.outcome = 'expired' then
      return query
      select
        'idempotency_key_expired'::text,
        409,
        jsonb_build_object(
          'error',
          jsonb_build_object(
            'code', 'idempotency_key_expired',
            'message', 'This Idempotency-Key has expired.'
          )
        ),
        false,
        null::uuid[];
      return;
    elsif v_claim.outcome = 'outcome_unknown' then
      return query
      select
        'idempotency_outcome_unknown'::text,
        409,
        jsonb_build_object(
          'error',
          jsonb_build_object(
            'code', 'idempotency_outcome_unknown',
            'message',
            'The original request outcome is unknown and will not be retried.'
          )
        ),
        false,
        null::uuid[];
      return;
    elsif v_claim.outcome <> 'claimed' then
      raise exception using
        errcode = '40001',
        message = 'unexpected idempotency claim outcome';
    end if;
  end if;

  select *
  into v_scan
  from public.invoice_scans
  where invoice_scans.id = p_scan_id
    and invoice_scans.restaurant_id = p_restaurant_id
  for update;

  if not found then
    v_body := jsonb_build_object(
      'error',
      jsonb_build_object(
        'code', 'not_found',
        'message', 'Scan not found.'
      )
    );
    if p_idempotency_key is not null then
      v_completed := public.complete_api_idempotency(
        p_restaurant_id,
        'api:POST:/api/scans/{param}/commit',
        p_idempotency_key,
        v_computed_hash,
        404,
        '{}'::jsonb,
        v_body
      );
      if not v_completed then
        raise exception using
          errcode = '40001',
          message = 'idempotency completion changed concurrently';
      end if;
    end if;
    return query
    select 'not_found'::text, 404, v_body, false, null::uuid[];
    return;
  end if;

  v_items := v_scan.final_line_items;
  if jsonb_typeof(v_items) is distinct from 'array'
     or jsonb_array_length(v_items) = 0
     or exists (
       select 1
       from jsonb_array_elements(v_items) as entry(item)
       where jsonb_typeof(item) is distinct from 'object'
         or jsonb_typeof(item -> 'id') is distinct from 'string'
         or jsonb_typeof(item -> 'name') is distinct from 'string'
         or jsonb_typeof(item -> 'producer') is distinct from 'string'
         or jsonb_typeof(item -> 'varietal') is distinct from 'string'
         or jsonb_typeof(item -> 'region') is distinct from 'string'
         or jsonb_typeof(item -> 'qty') is distinct from 'number'
         or case
           when jsonb_typeof(item -> 'qty') = 'number' then
             (item ->> 'qty')::numeric
               <> trunc((item ->> 'qty')::numeric)
             or (item ->> 'qty')::numeric <= 0
             or (item ->> 'qty')::numeric > 2147483647
           else false
         end
         or jsonb_typeof(item -> 'unitCost') is distinct from 'number'
         or case
           when jsonb_typeof(item -> 'unitCost') = 'number' then
             (item ->> 'unitCost')::numeric < 0
           else false
         end
         or jsonb_typeof(item -> 'confidence') is distinct from 'number'
         or case
           when jsonb_typeof(item -> 'confidence') = 'number' then
             (item ->> 'confidence')::numeric < 0
             or (item ->> 'confidence')::numeric > 1
           else false
         end
         or (
           jsonb_typeof(item -> 'vintage') is distinct from 'number'
           and jsonb_typeof(item -> 'vintage') is distinct from 'null'
         )
         or case
           when jsonb_typeof(item -> 'vintage') = 'number' then
             (item ->> 'vintage')::numeric
               <> trunc((item ->> 'vintage')::numeric)
             or (item ->> 'vintage')::numeric
               not between -2147483648 and 2147483647
           else false
         end
         or (
           item ? 'currency'
           and jsonb_typeof(item -> 'currency')
             not in ('string', 'null')
         )
         or (
           item ? 'format'
           and jsonb_typeof(item -> 'format')
             not in ('string', 'null')
         )
         or case
           when not (item ? 'lowFields') then false
           when jsonb_typeof(item -> 'lowFields') <> 'array' then true
           else exists (
               select 1
               from jsonb_array_elements_text(item -> 'lowFields')
                 as low_field(value)
               where value not in (
                 'name',
                 'producer',
                 'vintage',
                 'varietal',
                 'region',
                 'qty',
                 'unitCost',
                 'currency',
                 'format'
               )
             )
         end
     ) then
    v_body := jsonb_build_object(
      'error',
      jsonb_build_object(
        'code', 'bad_request',
        'message', 'Scan has no valid line items to commit.'
      )
    );
    if p_idempotency_key is not null then
      v_completed := public.complete_api_idempotency(
        p_restaurant_id,
        'api:POST:/api/scans/{param}/commit',
        p_idempotency_key,
        v_computed_hash,
        400,
        '{}'::jsonb,
        v_body
      );
      if not v_completed then
        raise exception using
          errcode = '40001',
          message = 'idempotency completion changed concurrently';
      end if;
    end if;
    return query
    select 'invalid_scan'::text, 400, v_body, false, null::uuid[];
    return;
  end if;

  select jsonb_agg(
    jsonb_build_object(
      'name', item ->> 'name',
      'producer', item ->> 'producer',
      'vintage', item -> 'vintage',
      'varietal', nullif(item ->> 'varietal', ''),
      'region', nullif(item ->> 'region', ''),
      'country', null,
      'size_ml', 750
    )
    order by ordinal
  )
  into v_wines
  from jsonb_array_elements(v_items) with ordinality
    as entries(item, ordinal);

  v_wine_ids := public.find_or_create_wines_batch(
    p_restaurant_id,
    v_wines
  );

  if cardinality(v_wine_ids) <> jsonb_array_length(v_items)
     or array_position(v_wine_ids, null) is not null then
    raise exception using
      errcode = 'P0001',
      message = 'find_or_create_wines_batch returned invalid IDs';
  end if;

  insert into public.inventory_items (
    wine_id,
    restaurant_id,
    invoice_scan_id,
    quantity,
    unit_cost,
    format,
    currency,
    added_via
  )
  select
    v_wine_ids[ordinal::integer],
    p_restaurant_id,
    p_scan_id,
    (item ->> 'qty')::integer,
    (item ->> 'unitCost')::numeric,
    item ->> 'format',
    item ->> 'currency',
    'invoice_scan'::public.added_via
  from jsonb_array_elements(v_items) with ordinality
    as entries(item, ordinal);

  select count(distinct wine_id)::integer
  into v_wine_count
  from unnest(v_wine_ids) as committed(wine_id);

  v_body := jsonb_build_object(
    'scanId', p_scan_id,
    'itemCount', jsonb_array_length(v_items),
    'wineCount', v_wine_count
  );

  if p_idempotency_key is not null then
    v_completed := public.complete_api_idempotency(
      p_restaurant_id,
      'api:POST:/api/scans/{param}/commit',
      p_idempotency_key,
      v_computed_hash,
      200,
      '{}'::jsonb,
      v_body
    );
    if not v_completed then
      raise exception using
        errcode = '40001',
        message = 'idempotency completion changed concurrently';
    end if;
  end if;

  return query
  select 'committed'::text, 200, v_body, false, v_wine_ids;
end;
$$;

revoke all on function public.commit_invoice_scan_idempotent(
  uuid,
  uuid,
  text,
  text
) from public;
revoke all on function public.commit_invoice_scan_idempotent(
  uuid,
  uuid,
  text,
  text
) from anon;
grant execute on function public.commit_invoice_scan_idempotent(
  uuid,
  uuid,
  text,
  text
) to authenticated;

comment on function public.commit_invoice_scan_idempotent(
  uuid,
  uuid,
  text,
  text
) is
  'Atomically creates wines and invoice inventory while storing or replaying the exact keyed API response.';

-- === 0066_confirm_bottle_scan_idempotency.sql ===
-- TER-020D19 — atomically bind bottle-location confirmation to its
-- caller-scoped idempotency response. A completed inventory insert and the
-- exact HTTP response now commit or roll back together.

create extension if not exists pgcrypto with schema extensions;

create or replace function public.confirm_bottle_scan_idempotent(
  p_restaurant_id uuid,
  p_wine_id uuid,
  p_section text,
  p_bin_location text,
  p_idempotency_key text default null,
  p_request_hash text default null
) returns table (
  outcome text,
  response_status integer,
  response_body jsonb,
  replayed boolean,
  execution_started_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_claim public.api_idempotency%rowtype;
  v_item public.inventory_items%rowtype;
  v_identity text;
  v_computed_hash text;
  v_outcome text;
  v_status integer;
  v_body jsonb;
  v_now timestamptz;
  v_started_at timestamptz := now();
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication required';
  end if;

  if p_restaurant_id is null
     or p_wine_id is null
     or p_section is null
     or p_bin_location is null then
    raise exception using
      errcode = '22023',
      message =
        'restaurant_id, wine_id, section, and bin_location are required';
  end if;

  if p_section <> pg_catalog.btrim(p_section)
     or char_length(p_section) not between 1 and 200
     or p_bin_location <> pg_catalog.btrim(p_bin_location)
     or char_length(p_bin_location) not between 1 and 200 then
    raise exception using
      errcode = '22023',
      message = 'section and bin_location must be normalized';
  end if;

  if not public.is_member_with_role(p_restaurant_id, 'staff') then
    raise exception using
      errcode = '42501',
      message = 'forbidden';
  end if;

  -- createIdempotencyRequestHash sorts keys before framing canonical JSON.
  -- Keep this reconstruction explicit so the database verifies the caller's
  -- exact normalized identity instead of trusting a supplied digest.
  v_identity :=
    '{"bin_location":'
      || pg_catalog.to_json(p_bin_location)::text
      || ',"section":'
      || pg_catalog.to_json(p_section)::text
      || ',"wine_id":'
      || pg_catalog.to_json(p_wine_id::text)::text
      || '}';
  v_computed_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.int8send(
        pg_catalog.octet_length(
          pg_catalog.convert_to(v_identity, 'UTF8')
        )::bigint
      ) || pg_catalog.convert_to(v_identity, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  if p_idempotency_key is null and p_request_hash is not null then
    raise exception using
      errcode = '22023',
      message = 'request hash requires an idempotency key';
  end if;

  if p_idempotency_key is not null then
    if char_length(p_idempotency_key) not between 8 and 128
       or p_idempotency_key !~ '^[A-Za-z0-9_-]+$' then
      raise exception using
        errcode = '22023',
        message = 'invalid idempotency key';
    end if;

    if p_request_hash is null
       or p_request_hash !~ '^[0-9a-f]{64}$'
       or p_request_hash <> v_computed_hash then
      raise exception using
        errcode = '22023',
        message =
          'request hash does not match the canonical confirmation identity';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        v_user_id::text || ':' || p_idempotency_key,
        0
      )
    );

    loop
      select *
      into v_claim
      from public.api_idempotency
      where api_idempotency.user_id = v_user_id
        and api_idempotency.idempotency_key = p_idempotency_key
      for update;

      if found then
        if v_claim.restaurant_id <> p_restaurant_id
           or v_claim.operation_id
                <> 'api:POST:/api/scan-bottle/confirm'
           or v_claim.request_hash <> v_computed_hash then
          return query
          select
            'idempotency_key_reused'::text,
            409,
            jsonb_build_object(
              'error',
              jsonb_build_object(
                'code', 'idempotency_key_reused',
                'message',
                'This Idempotency-Key was already used for a different request.'
              )
            ),
            false,
            v_claim.created_at;
          return;
        end if;

        if v_claim.updated_at
             < clock_timestamp() - interval '24 hours' then
          return query
          select
            'idempotency_key_expired'::text,
            409,
            jsonb_build_object(
              'error',
              jsonb_build_object(
                'code', 'idempotency_key_expired',
                'message', 'This Idempotency-Key has expired.'
              )
            ),
            false,
            v_claim.created_at;
          return;
        end if;

        if v_claim.state = 'completed' then
          return query
          select
            'replay'::text,
            v_claim.response_status,
            v_claim.response_body,
            true,
            v_claim.created_at;
          return;
        end if;

        if v_claim.state = 'failed_unknown' then
          return query
          select
            'idempotency_outcome_unknown'::text,
            409,
            jsonb_build_object(
              'error',
              jsonb_build_object(
                'code', 'idempotency_outcome_unknown',
                'message',
                'The original request outcome is unknown and will not be retried.'
              )
            ),
            false,
            v_claim.created_at;
          return;
        end if;

        return query
        select
          'idempotency_in_progress'::text,
          409,
          jsonb_build_object(
            'error',
            jsonb_build_object(
              'code', 'idempotency_in_progress',
              'message',
              'A request with this Idempotency-Key is still in progress.'
            )
          ),
          false,
          v_claim.created_at;
        return;
      end if;

      insert into public.api_idempotency (
        restaurant_id,
        user_id,
        operation_id,
        idempotency_key,
        request_hash
      ) values (
        p_restaurant_id,
        v_user_id,
        'api:POST:/api/scan-bottle/confirm',
        p_idempotency_key,
        v_computed_hash
      )
      on conflict (user_id, idempotency_key) do nothing
      returning * into v_claim;

      if found then
        v_started_at := v_claim.created_at;
        exit;
      end if;
    end loop;
  end if;

  if not exists (
    select 1
    from public.wines
    where wines.id = p_wine_id
      and wines.restaurant_id = p_restaurant_id
  ) then
    v_outcome := 'wine_not_found';
    v_status := 404;
    v_body := jsonb_build_object(
      'error',
      jsonb_build_object(
        'code', 'wine_not_found',
        'message', 'Wine not found or not in your restaurant.'
      )
    );
  else
    insert into public.inventory_items (
      wine_id,
      restaurant_id,
      section,
      bin_location,
      quantity,
      unit_cost,
      added_via
    ) values (
      p_wine_id,
      p_restaurant_id,
      p_section,
      p_bin_location,
      1,
      0,
      'manual'
    )
    returning * into v_item;

    v_outcome := 'confirmed';
    v_status := 201;
    v_body := jsonb_build_object(
      'id', v_item.id,
      'section', v_item.section,
      'bin_location', v_item.bin_location,
      'added_at', v_item.added_at,
      'wine_id', v_item.wine_id
    );
  end if;

  if p_idempotency_key is not null then
    v_now := clock_timestamp();
    update public.api_idempotency
    set state = 'completed',
        response_status = v_status,
        response_headers = '{}'::jsonb,
        response_body = v_body,
        updated_at = v_now,
        completed_at = v_now
    where api_idempotency.restaurant_id = p_restaurant_id
      and api_idempotency.user_id = v_user_id
      and api_idempotency.operation_id
            = 'api:POST:/api/scan-bottle/confirm'
      and api_idempotency.idempotency_key = p_idempotency_key
      and api_idempotency.request_hash = v_computed_hash
      and api_idempotency.state = 'in_progress';

    if not found then
      raise exception using
        errcode = '40001',
        message = 'idempotency completion changed concurrently';
    end if;
  end if;

  return query
  select
    v_outcome,
    v_status,
    v_body,
    false,
    v_started_at;
end;
$$;

revoke all on function public.confirm_bottle_scan_idempotent(
  uuid,
  uuid,
  text,
  text,
  text,
  text
) from public;
revoke all on function public.confirm_bottle_scan_idempotent(
  uuid,
  uuid,
  text,
  text,
  text,
  text
) from anon;
grant execute on function public.confirm_bottle_scan_idempotent(
  uuid,
  uuid,
  text,
  text,
  text,
  text
) to authenticated;

comment on function public.confirm_bottle_scan_idempotent(
  uuid,
  uuid,
  text,
  text,
  text,
  text
) is
  'Atomically inserts confirmed bottle inventory and stores or replays its exact keyed response.';

-- === 0067_restaurant_lifecycle_idempotency.sql ===
-- TER-020D20 — preserve exact retry semantics for restaurant deletion.
--
-- A restaurant is the root of the tenant graph. Deleting it cascades the
-- caller's membership and, before this migration, the generic idempotency
-- record itself. Keep those private records for their existing 24-hour
-- observable TTL and execute the delete plus response completion in one
-- transaction. The existing cleanup job still removes expired records.

create extension if not exists pgcrypto with schema extensions;

alter table public.api_idempotency
  drop constraint if exists api_idempotency_restaurant_id_fkey;

create or replace function public.delete_restaurant_idempotent(
  p_restaurant_id uuid,
  p_active_restaurant_id uuid default null,
  p_idempotency_key text default null,
  p_request_hash text default null
) returns table (
  outcome text,
  response_status integer,
  response_body jsonb,
  replayed boolean,
  execution_started_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_claim public.api_idempotency%rowtype;
  v_role public.membership_role;
  v_identity text;
  v_request_hash text;
  v_now timestamptz;
  v_started_at timestamptz := now();
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication required';
  end if;

  if p_restaurant_id is null then
    raise exception using
      errcode = '22023',
      message = 'restaurant_id is required';
  end if;

  -- createIdempotencyRequestHash({ id }) sorts this single key and frames the
  -- UTF-8 canonical JSON with an eight-byte big-endian length.
  v_identity :=
    '{"id":' || pg_catalog.to_json(p_restaurant_id::text)::text || '}';
  v_request_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.int8send(
        pg_catalog.octet_length(
          pg_catalog.convert_to(v_identity, 'UTF8')
        )::bigint
      ) || pg_catalog.convert_to(v_identity, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  if p_idempotency_key is null and p_request_hash is not null then
    raise exception using
      errcode = '22023',
      message = 'request hash requires an idempotency key';
  end if;

  if p_idempotency_key is not null then
    if char_length(p_idempotency_key) not between 8 and 128
       or p_idempotency_key !~ '^[A-Za-z0-9_-]+$' then
      raise exception using
        errcode = '22023',
        message = 'invalid idempotency key';
    end if;

    if p_request_hash is null
       or p_request_hash !~ '^[0-9a-f]{64}$' then
      raise exception using
        errcode = '22023',
        message = 'invalid request hash';
    end if;

    if p_request_hash <> v_request_hash then
      raise exception using
        errcode = '22023',
        message = 'request hash does not match the canonical deletion identity';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        v_user_id::text || ':' || p_idempotency_key,
        0
      )
    );

    select *
    into v_claim
    from public.api_idempotency
    where api_idempotency.user_id = v_user_id
      and api_idempotency.idempotency_key = p_idempotency_key
    for update;

    if found then
      if v_claim.restaurant_id <> p_restaurant_id
         or v_claim.operation_id
              <> 'api:DELETE:/api/restaurant/{param}'
         or v_claim.request_hash <> v_request_hash then
        return query
        select
          'idempotency_key_reused'::text,
          409,
          jsonb_build_object(
            'error',
            jsonb_build_object(
              'code', 'idempotency_key_reused',
              'message',
              'This Idempotency-Key was already used for a different request.'
            )
          ),
          false,
          v_claim.created_at;
        return;
      end if;

      if v_claim.updated_at
           < clock_timestamp() - interval '24 hours' then
        return query
        select
          'idempotency_key_expired'::text,
          409,
          jsonb_build_object(
            'error',
            jsonb_build_object(
              'code', 'idempotency_key_expired',
              'message', 'This Idempotency-Key has expired.'
            )
          ),
          false,
          v_claim.created_at;
        return;
      end if;

      if v_claim.state = 'completed' then
        return query
        select
          'replay'::text,
          v_claim.response_status,
          v_claim.response_body,
          true,
          v_claim.created_at;
        return;
      end if;

      if v_claim.state = 'failed_unknown' then
        return query
        select
          'idempotency_outcome_unknown'::text,
          409,
          jsonb_build_object(
            'error',
            jsonb_build_object(
              'code', 'idempotency_outcome_unknown',
              'message',
              'The original request outcome is unknown and will not be retried.'
            )
          ),
          false,
          v_claim.created_at;
        return;
      end if;

      return query
      select
        'idempotency_in_progress'::text,
        409,
        jsonb_build_object(
          'error',
          jsonb_build_object(
            'code', 'idempotency_in_progress',
            'message',
            'A request with this Idempotency-Key is still in progress.'
          )
        ),
        false,
        v_claim.created_at;
      return;
    end if;
  end if;

  -- Preserve the prior route's active-tenant and owner semantics for every
  -- new command. Replays above are intentionally resolved first because the
  -- successful delete has already cascaded this membership.
  if p_active_restaurant_id is null then
    return query
    select
      'no_membership'::text,
      403,
      jsonb_build_object(
        'error',
        jsonb_build_object(
          'code', 'forbidden',
          'message', 'No restaurant membership found.'
        )
      ),
      false,
      v_started_at;
    return;
  end if;

  if p_active_restaurant_id <> p_restaurant_id then
    return query
    select
      'forbidden'::text,
      403,
      jsonb_build_object(
        'error',
        jsonb_build_object(
          'code', 'forbidden',
          'message', 'Forbidden.'
        )
      ),
      false,
      v_started_at;
    return;
  end if;

  select role
  into v_role
  from public.memberships
  where restaurant_id = p_restaurant_id
    and user_id = v_user_id
  for update;

  if not found then
    return query
    select
      'no_membership'::text,
      403,
      jsonb_build_object(
        'error',
        jsonb_build_object(
          'code', 'forbidden',
          'message', 'No restaurant membership found.'
        )
      ),
      false,
      v_started_at;
    return;
  end if;

  if v_role <> 'owner' then
    return query
    select
      'owner_required'::text,
      403,
      jsonb_build_object(
        'error',
        jsonb_build_object(
          'code', 'forbidden',
          'message', 'Owner access required.'
        )
      ),
      false,
      v_started_at;
    return;
  end if;

  if p_idempotency_key is not null then
    insert into public.api_idempotency (
      restaurant_id,
      user_id,
      operation_id,
      idempotency_key,
      request_hash
    ) values (
      p_restaurant_id,
      v_user_id,
      'api:DELETE:/api/restaurant/{param}',
      p_idempotency_key,
      v_request_hash
    )
    returning * into v_claim;

    v_started_at := v_claim.created_at;
  end if;

  delete from public.restaurants
  where id = p_restaurant_id;

  if not found then
    raise exception using
      errcode = '40001',
      message = 'restaurant deletion target changed concurrently';
  end if;

  if p_idempotency_key is not null then
    v_now := clock_timestamp();
    update public.api_idempotency
    set state = 'completed',
        response_status = 200,
        response_headers = '{}'::jsonb,
        response_body = jsonb_build_object('ok', true),
        updated_at = v_now,
        completed_at = v_now
    where api_idempotency.restaurant_id = p_restaurant_id
      and api_idempotency.user_id = v_user_id
      and api_idempotency.operation_id
            = 'api:DELETE:/api/restaurant/{param}'
      and api_idempotency.idempotency_key = p_idempotency_key
      and api_idempotency.request_hash = v_request_hash
      and api_idempotency.state = 'in_progress';

    if not found then
      raise exception using
        errcode = '40001',
        message = 'idempotency completion changed concurrently';
    end if;
  end if;

  return query
  select
    'deleted'::text,
    200,
    jsonb_build_object('ok', true),
    false,
    v_started_at;
end;
$$;

revoke all on function public.delete_restaurant_idempotent(
  uuid,
  uuid,
  text,
  text
) from public;
revoke all on function public.delete_restaurant_idempotent(
  uuid,
  uuid,
  text,
  text
) from anon;
grant execute on function public.delete_restaurant_idempotent(
  uuid,
  uuid,
  text,
  text
) to authenticated;

comment on function public.delete_restaurant_idempotent(
  uuid,
  uuid,
  text,
  text
) is
  'Atomically deletes the active owner restaurant and stores or replays the exact keyed API response.';

comment on column public.api_idempotency.restaurant_id is
  'Immutable tenant identity. Intentionally retained after tenant deletion until the private idempotency record expires.';

-- === 0068_reorder_wine_list_sections.sql ===
-- TER-020D21 — atomically create and reorder wine-list sections.
--
-- Creation and reorder share a parent-list lock. A new section therefore
-- allocates its position after any in-flight reorder, while reorder persists
-- every submitted position in one statement.

create or replace function public.create_wine_list_section(
  p_restaurant_id uuid,
  p_wine_list_id uuid,
  p_name text
) returns table (
  id uuid,
  wine_list_id uuid,
  name text,
  "position" integer,
  created_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_position integer;
begin
  perform 1
  from public.wine_lists as list
  where list.id = p_wine_list_id
    and list.restaurant_id = p_restaurant_id
  for update;

  if not found then
    raise exception using
      errcode = 'T2105',
      message = 'wine list not found or inaccessible';
  end if;

  if not public.is_member_with_role(p_restaurant_id, 'manager') then
    raise exception using
      errcode = 'T2106',
      message = 'manager role required';
  end if;

  select coalesce(max(section.position), -1) + 1
  into v_position
  from public.wine_list_sections as section
  where section.wine_list_id = p_wine_list_id;

  return query
  insert into public.wine_list_sections (
    wine_list_id,
    name,
    position
  ) values (
    p_wine_list_id,
    p_name,
    v_position
  )
  returning
    wine_list_sections.id,
    wine_list_sections.wine_list_id,
    wine_list_sections.name,
    wine_list_sections.position,
    wine_list_sections.created_at;
end;
$$;

create or replace function public.reorder_wine_list_sections(
  p_ordered_ids uuid[]
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_list_id uuid;
  v_restaurant_id uuid;
  v_input_len integer := coalesce(array_length(p_ordered_ids, 1), 0);
  v_match_count integer;
  v_total_count integer;
begin
  if v_input_len = 0 or v_input_len > 200 then
    raise exception using
      errcode = 'T2101',
      message = 'ordered section id count is invalid';
  end if;

  if v_input_len <> (
    select count(distinct section_id)
    from unnest(p_ordered_ids) as submitted(section_id)
  ) then
    raise exception using
      errcode = 'T2101',
      message = 'ordered section ids must be unique';
  end if;

  select list.id, list.restaurant_id
  into v_list_id, v_restaurant_id
  from public.wine_list_sections as section
  join public.wine_lists as list on list.id = section.wine_list_id
  where section.id = p_ordered_ids[1]
  for update of list;

  if v_list_id is null then
    raise exception using
      errcode = 'T2102',
      message = 'section not found or inaccessible';
  end if;

  if not public.is_member_with_role(v_restaurant_id, 'manager') then
    raise exception using
      errcode = 'T2104',
      message = 'manager role required';
  end if;

  -- Lock every current section in a deterministic order. Concurrent reorders
  -- therefore serialize instead of deadlocking, while concurrent deletes
  -- cannot invalidate the validated set between this check and the update.
  select count(*)
  into v_total_count
  from (
    select section.id
    from public.wine_list_sections as section
    where section.wine_list_id = v_list_id
    order by section.id
    for update
  ) as locked_sections;

  select count(*)
  into v_match_count
  from public.wine_list_sections as section
  where section.id = any(p_ordered_ids)
    and section.wine_list_id = v_list_id;

  if v_match_count <> v_input_len then
    raise exception using
      errcode = 'T2102',
      message = 'all sections must belong to one accessible wine list';
  end if;

  if v_total_count <> v_input_len then
    raise exception using
      errcode = 'T2103',
      message = 'ordered section ids must include the complete wine list';
  end if;

  update public.wine_list_sections as section
  set position = submitted.ordinality - 1
  from unnest(p_ordered_ids) with ordinality
    as submitted(section_id, ordinality)
  where section.id = submitted.section_id
    and section.wine_list_id = v_list_id;
end;
$$;

revoke all on function public.create_wine_list_section(
  uuid,
  uuid,
  text
) from public;
revoke all on function public.create_wine_list_section(
  uuid,
  uuid,
  text
) from anon;
grant execute on function public.create_wine_list_section(
  uuid,
  uuid,
  text
) to authenticated;

revoke all on function public.reorder_wine_list_sections(uuid[])
  from public;
revoke all on function public.reorder_wine_list_sections(uuid[])
  from anon;
grant execute on function public.reorder_wine_list_sections(uuid[])
  to authenticated;

comment on function public.create_wine_list_section(uuid, uuid, text) is
  'Creates a section at the next stable position under the parent-list lock.';

comment on function public.reorder_wine_list_sections(uuid[]) is
  'Atomically persists a validated, same-list section order under existing RLS.';

-- === 0069_wine_list_publication_idempotency.sql ===
-- TER-020D22 — make wine-list cloning and publication atomically retry-safe.
--
-- Clone allocates a list plus section and item UUIDs. Publish can allocate a
-- public slug. These functions commit each business result and its exact HTTP
-- response in one transaction so a lost response cannot duplicate a clone or
-- change the public URL on retry.

create extension if not exists pgcrypto with schema extensions;

create or replace function public.clone_wine_list_idempotent(
  p_restaurant_id uuid,
  p_wine_list_id uuid,
  p_idempotency_key text default null,
  p_request_hash text default null
) returns table (
  outcome text,
  response_status integer,
  response_body jsonb,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_claim record;
  v_source public.wine_lists%rowtype;
  v_clone_id uuid;
  v_identity text;
  v_computed_hash text;
  v_body jsonb;
  v_completed boolean;
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication required';
  end if;

  if p_restaurant_id is null or p_wine_list_id is null then
    raise exception using
      errcode = '22023',
      message = 'restaurant_id and wine_list_id are required';
  end if;

  if not public.is_member_with_role(p_restaurant_id, 'manager') then
    raise exception using
      errcode = '42501',
      message = 'forbidden';
  end if;

  v_identity :=
    '{"id":'
    || pg_catalog.to_json(p_wine_list_id::text)::text
    || '}';
  v_computed_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.int8send(
        pg_catalog.octet_length(
          pg_catalog.convert_to(v_identity, 'UTF8')
        )::bigint
      ) || pg_catalog.convert_to(v_identity, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  if p_idempotency_key is null and p_request_hash is not null then
    raise exception using
      errcode = '22023',
      message = 'request hash requires an idempotency key';
  end if;

  if p_idempotency_key is not null then
    if p_request_hash is null or p_request_hash <> v_computed_hash then
      raise exception using
        errcode = '22023',
        message = 'request hash does not match the canonical clone identity';
    end if;

    select *
    into v_claim
    from public.claim_api_idempotency(
      p_restaurant_id,
      'api:POST:/api/wine-lists/{param}/clone',
      p_idempotency_key,
      v_computed_hash
    );

    if v_claim.outcome = 'replay' then
      return query
      select
        'replay'::text,
        v_claim.response_status,
        v_claim.response_body,
        true;
      return;
    elsif v_claim.outcome = 'in_progress' then
      return query
      select
        'idempotency_in_progress'::text,
        409,
        jsonb_build_object(
          'error',
          jsonb_build_object(
            'code', 'idempotency_in_progress',
            'message',
            'A request with this Idempotency-Key is still in progress.'
          )
        ),
        false;
      return;
    elsif v_claim.outcome = 'mismatch' then
      return query
      select
        'idempotency_key_reused'::text,
        409,
        jsonb_build_object(
          'error',
          jsonb_build_object(
            'code', 'idempotency_key_reused',
            'message',
            'This Idempotency-Key was already used for a different request.'
          )
        ),
        false;
      return;
    elsif v_claim.outcome = 'expired' then
      return query
      select
        'idempotency_key_expired'::text,
        409,
        jsonb_build_object(
          'error',
          jsonb_build_object(
            'code', 'idempotency_key_expired',
            'message', 'This Idempotency-Key has expired.'
          )
        ),
        false;
      return;
    elsif v_claim.outcome = 'outcome_unknown' then
      return query
      select
        'idempotency_outcome_unknown'::text,
        409,
        jsonb_build_object(
          'error',
          jsonb_build_object(
            'code', 'idempotency_outcome_unknown',
            'message',
            'The original request outcome is unknown and will not be retried.'
          )
        ),
        false;
      return;
    elsif v_claim.outcome is distinct from 'claimed' then
      raise exception using
        errcode = '40001',
        message = 'unexpected idempotency claim outcome';
    end if;
  end if;

  select list.*
  into v_source
  from public.wine_lists list
  where list.id = p_wine_list_id
    and list.restaurant_id = p_restaurant_id
  for share;

  if not found then
    v_body := jsonb_build_object(
      'error',
      jsonb_build_object(
        'code', 'not_found',
        'message', 'Wine list not found.'
      )
    );
    if p_idempotency_key is not null then
      v_completed := public.complete_api_idempotency(
        p_restaurant_id,
        'api:POST:/api/wine-lists/{param}/clone',
        p_idempotency_key,
        v_computed_hash,
        404,
        '{}'::jsonb,
        v_body
      );
      if not v_completed then
        raise exception using
          errcode = '40001',
          message = 'idempotency completion changed concurrently';
      end if;
    end if;
    return query
    select 'not_found'::text, 404, v_body, false;
    return;
  end if;

  insert into public.wine_lists (
    restaurant_id,
    name,
    description,
    template,
    slug,
    is_published,
    archived
  ) values (
    p_restaurant_id,
    v_source.name || ' (copy)',
    v_source.description,
    v_source.template,
    null,
    false,
    false
  )
  returning id into v_clone_id;

  -- Allocate the section mapping and copy every descendant in one statement.
  -- Every CTE reads one READ COMMITTED snapshot, so a concurrent direct table
  -- insert/update/delete is either wholly before or wholly after this clone.
  with section_map as materialized (
    select
      section.id as source_section_id,
      extensions.gen_random_uuid() as clone_section_id,
      section.name,
      section.position
    from public.wine_list_sections section
    where section.wine_list_id = p_wine_list_id
  ),
  inserted_sections as (
    insert into public.wine_list_sections (
      id,
      wine_list_id,
      name,
      position
    )
    select
      map.clone_section_id,
      v_clone_id,
      map.name,
      map.position
    from section_map map
    order by map.position, map.source_section_id
    returning id
  )
  insert into public.wine_list_items (
    section_id,
    wine_id,
    bottle_price,
    glass_price,
    glass_pour_ml,
    pour_size_mode,
    position,
    is_available,
    tasting_note,
    name_override,
    blurb,
    hidden
  )
  select
    map.clone_section_id,
    item.wine_id,
    item.bottle_price,
    item.glass_price,
    item.glass_pour_ml,
    item.pour_size_mode,
    item.position,
    item.is_available,
    item.tasting_note,
    item.name_override,
    item.blurb,
    item.hidden
  from section_map map
  join inserted_sections inserted
    on inserted.id = map.clone_section_id
  join public.wine_list_items item
    on item.section_id = map.source_section_id
  order by map.position, map.source_section_id, item.position, item.id;

  v_body := jsonb_build_object('id', v_clone_id);
  if p_idempotency_key is not null then
    v_completed := public.complete_api_idempotency(
      p_restaurant_id,
      'api:POST:/api/wine-lists/{param}/clone',
      p_idempotency_key,
      v_computed_hash,
      200,
      '{}'::jsonb,
      v_body
    );
    if not v_completed then
      raise exception using
        errcode = '40001',
        message = 'idempotency completion changed concurrently';
    end if;
  end if;

  return query
  select 'cloned'::text, 200, v_body, false;
end;
$$;

create or replace function public.set_wine_list_publication_idempotent(
  p_restaurant_id uuid,
  p_wine_list_id uuid,
  p_publish boolean,
  p_has_slug boolean default false,
  p_slug text default null,
  p_idempotency_key text default null,
  p_request_hash text default null
) returns table (
  outcome text,
  response_status integer,
  response_body jsonb,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_claim record;
  v_list public.wine_lists%rowtype;
  v_operation_id text;
  v_identity text;
  v_computed_hash text;
  v_slug text;
  v_slug_source text;
  v_restaurant_name text;
  v_generated_slug boolean := false;
  v_slug_attempt integer := 0;
  v_body jsonb;
  v_completed boolean;
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication required';
  end if;

  if p_restaurant_id is null
     or p_wine_list_id is null
     or p_publish is null
     or p_has_slug is null then
    raise exception using
      errcode = '22023',
      message = 'restaurant_id, wine_list_id, publish, and has_slug are required';
  end if;

  if not public.is_member_with_role(p_restaurant_id, 'manager') then
    raise exception using
      errcode = '42501',
      message = 'forbidden';
  end if;

  if p_publish then
    if p_has_slug then
      if p_slug is null
         or char_length(p_slug) > 50
         or p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
        raise exception using
          errcode = '22023',
          message = 'invalid publication slug';
      end if;
    elsif p_slug is not null then
      raise exception using
        errcode = '22023',
        message = 'slug requires has_slug';
    end if;
    v_operation_id := 'api:POST:/api/wine-lists/{param}/publish';
    v_identity :=
      '{"body":'
      || case
        when p_has_slug then
          '{"slug":' || pg_catalog.to_json(p_slug)::text || '}'
        else '{}'
      end
      || ',"id":'
      || pg_catalog.to_json(p_wine_list_id::text)::text
      || '}';
  else
    if p_has_slug or p_slug is not null then
      raise exception using
        errcode = '22023',
        message = 'unpublish does not accept a slug';
    end if;
    v_operation_id := 'api:DELETE:/api/wine-lists/{param}/publish';
    v_identity :=
      '{"id":'
      || pg_catalog.to_json(p_wine_list_id::text)::text
      || '}';
  end if;

  v_computed_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.int8send(
        pg_catalog.octet_length(
          pg_catalog.convert_to(v_identity, 'UTF8')
        )::bigint
      ) || pg_catalog.convert_to(v_identity, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  if p_idempotency_key is null and p_request_hash is not null then
    raise exception using
      errcode = '22023',
      message = 'request hash requires an idempotency key';
  end if;

  if p_idempotency_key is not null then
    if p_request_hash is null or p_request_hash <> v_computed_hash then
      raise exception using
        errcode = '22023',
        message = 'request hash does not match publication identity';
    end if;

    select *
    into v_claim
    from public.claim_api_idempotency(
      p_restaurant_id,
      v_operation_id,
      p_idempotency_key,
      v_computed_hash
    );

    if v_claim.outcome = 'replay' then
      return query
      select
        'replay'::text,
        v_claim.response_status,
        v_claim.response_body,
        true;
      return;
    elsif v_claim.outcome = 'in_progress' then
      return query
      select
        'idempotency_in_progress'::text,
        409,
        jsonb_build_object(
          'error',
          jsonb_build_object(
            'code', 'idempotency_in_progress',
            'message',
            'A request with this Idempotency-Key is still in progress.'
          )
        ),
        false;
      return;
    elsif v_claim.outcome = 'mismatch' then
      return query
      select
        'idempotency_key_reused'::text,
        409,
        jsonb_build_object(
          'error',
          jsonb_build_object(
            'code', 'idempotency_key_reused',
            'message',
            'This Idempotency-Key was already used for a different request.'
          )
        ),
        false;
      return;
    elsif v_claim.outcome = 'expired' then
      return query
      select
        'idempotency_key_expired'::text,
        409,
        jsonb_build_object(
          'error',
          jsonb_build_object(
            'code', 'idempotency_key_expired',
            'message', 'This Idempotency-Key has expired.'
          )
        ),
        false;
      return;
    elsif v_claim.outcome = 'outcome_unknown' then
      return query
      select
        'idempotency_outcome_unknown'::text,
        409,
        jsonb_build_object(
          'error',
          jsonb_build_object(
            'code', 'idempotency_outcome_unknown',
            'message',
            'The original request outcome is unknown and will not be retried.'
          )
        ),
        false;
      return;
    elsif v_claim.outcome is distinct from 'claimed' then
      raise exception using
        errcode = '40001',
        message = 'unexpected idempotency claim outcome';
    end if;
  end if;

  select list.*
  into v_list
  from public.wine_lists list
  where list.id = p_wine_list_id
    and list.restaurant_id = p_restaurant_id
  for update;

  if not found then
    v_body := jsonb_build_object(
      'error',
      jsonb_build_object(
        'code', 'not_found',
        'message', 'Wine list not found.'
      )
    );
    if p_idempotency_key is not null then
      v_completed := public.complete_api_idempotency(
        p_restaurant_id,
        v_operation_id,
        p_idempotency_key,
        v_computed_hash,
        404,
        '{}'::jsonb,
        v_body
      );
      if not v_completed then
        raise exception using
          errcode = '40001',
          message = 'idempotency completion changed concurrently';
      end if;
    end if;
    return query
    select 'not_found'::text, 404, v_body, false;
    return;
  end if;

  if not p_publish then
    update public.wine_lists
    set is_published = false,
        slug = null
    where id = p_wine_list_id
      and restaurant_id = p_restaurant_id;

    v_body := jsonb_build_object('ok', true);
    if p_idempotency_key is not null then
      v_completed := public.complete_api_idempotency(
        p_restaurant_id,
        v_operation_id,
        p_idempotency_key,
        v_computed_hash,
        200,
        '{}'::jsonb,
        v_body
      );
      if not v_completed then
        raise exception using
          errcode = '40001',
          message = 'idempotency completion changed concurrently';
      end if;
    end if;
    return query
    select 'unpublished'::text, 200, v_body, false;
    return;
  end if;

  if p_has_slug then
    v_slug := p_slug;
  elsif v_list.slug is not null
        and char_length(v_list.slug) <= 50
        and v_list.slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
    v_slug := v_list.slug;
  else
    select restaurant.name
    into v_restaurant_name
    from public.restaurants restaurant
    where restaurant.id = p_restaurant_id;

    if v_restaurant_name is null then
      raise exception using
        errcode = '23503',
        message = 'wine-list restaurant was not found';
    end if;
    v_slug_source := pg_catalog.regexp_replace(
      pg_catalog.lower(pg_catalog.btrim(v_restaurant_name)),
      '[^a-z0-9]+',
      '-',
      'g'
    );
    v_slug_source := pg_catalog.regexp_replace(
      v_slug_source,
      '^-+|-+$',
      '',
      'g'
    );
    v_slug_source := pg_catalog.regexp_replace(
      pg_catalog.left(v_slug_source, 40),
      '-+$',
      '',
      'g'
    );
    if v_slug_source = '' then
      v_slug_source := 'wine-list';
    end if;
    v_generated_slug := true;
  end if;

  loop
    v_slug_attempt := v_slug_attempt + 1;
    if v_generated_slug then
      v_slug := public.generate_slug(v_slug_source);
      if char_length(v_slug) > 50
         or v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
        raise exception using
          errcode = '22023',
          message = 'generated publication slug was invalid';
      end if;
    end if;

    begin
      update public.wine_lists
      set is_published = true,
          last_published_at = clock_timestamp(),
          slug = v_slug
      where id = p_wine_list_id
        and restaurant_id = p_restaurant_id;
      exit;
    exception when unique_violation then
      if v_generated_slug then
        if v_slug_attempt < 16 then
          continue;
        end if;
        raise exception using
          errcode = '40001',
          message = 'could not allocate a unique publication slug';
      end if;

      v_body := jsonb_build_object(
        'error',
        jsonb_build_object(
          'code', 'slug_collision',
          'message', 'This slug is already in use.'
        )
      );
      if p_idempotency_key is not null then
        v_completed := public.complete_api_idempotency(
          p_restaurant_id,
          v_operation_id,
          p_idempotency_key,
          v_computed_hash,
          409,
          '{}'::jsonb,
          v_body
        );
        if not v_completed then
          raise exception using
            errcode = '40001',
            message = 'idempotency completion changed concurrently';
        end if;
      end if;
      return query
      select 'slug_collision'::text, 409, v_body, false;
      return;
    end;
  end loop;

  v_body := jsonb_build_object('slug', v_slug);
  if p_idempotency_key is not null then
    v_completed := public.complete_api_idempotency(
      p_restaurant_id,
      v_operation_id,
      p_idempotency_key,
      v_computed_hash,
      200,
      '{}'::jsonb,
      v_body
    );
    if not v_completed then
      raise exception using
        errcode = '40001',
        message = 'idempotency completion changed concurrently';
    end if;
  end if;

  return query
  select 'published'::text, 200, v_body, false;
end;
$$;

revoke all on function public.clone_wine_list_idempotent(
  uuid,
  uuid,
  text,
  text
) from public;
revoke all on function public.clone_wine_list_idempotent(
  uuid,
  uuid,
  text,
  text
) from anon;
grant execute on function public.clone_wine_list_idempotent(
  uuid,
  uuid,
  text,
  text
) to authenticated;

revoke all on function public.set_wine_list_publication_idempotent(
  uuid,
  uuid,
  boolean,
  boolean,
  text,
  text,
  text
) from public;
revoke all on function public.set_wine_list_publication_idempotent(
  uuid,
  uuid,
  boolean,
  boolean,
  text,
  text,
  text
) from anon;
grant execute on function public.set_wine_list_publication_idempotent(
  uuid,
  uuid,
  boolean,
  boolean,
  text,
  text,
  text
) to authenticated;

comment on function public.clone_wine_list_idempotent(
  uuid,
  uuid,
  text,
  text
) is
  'Atomically clones an owned wine list and stores the exact keyed response.';
comment on function public.set_wine_list_publication_idempotent(
  uuid,
  uuid,
  boolean,
  boolean,
  text,
  text,
  text
) is
  'Atomically publishes or unpublishes a wine list with exact keyed replay.';

-- === 0070_cellar_lifecycle_idempotency.sql ===
-- TER-020D23 — make the remaining cellar lifecycle mutations retry-safe.
--
-- The previous handlers claimed and mutated through separate HTTP/database
-- calls. These commands commit the claim, cellar write, and exact response in
-- one transaction, so a retry after a lost response cannot duplicate inventory
-- or repeat a wine deletion.

create extension if not exists pgcrypto with schema extensions;

create or replace function public.add_cellar_wine_idempotent(
  p_restaurant_id uuid,
  p_name text,
  p_producer text,
  p_vintage integer default null,
  p_varietal text default null,
  p_region text default null,
  p_country text default null,
  p_quantity integer default 1,
  p_unit_cost numeric default 0,
  p_idempotency_key text default null,
  p_request_hash text default null
) returns table (
  outcome text,
  response_status integer,
  response_body jsonb,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_claim record;
  v_identity text;
  v_computed_hash text;
  v_wine_ids uuid[];
  v_wine_id uuid;
  v_inventory public.inventory_items%rowtype;
  v_body jsonb;
  v_completed boolean;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;

  if p_restaurant_id is null
     or p_name is null or p_name <> btrim(p_name)
     or char_length(p_name) not between 1 and 200
     or p_producer is null or p_producer <> btrim(p_producer)
     or char_length(p_producer) not between 1 and 200
     or (p_vintage is not null and p_vintage not between 1900 and 2100)
     or (p_varietal is not null and (
       p_varietal <> btrim(p_varietal) or char_length(p_varietal) > 100
     ))
     or (p_region is not null and (
       p_region <> btrim(p_region) or char_length(p_region) > 100
     ))
     or (p_country is not null and (
       p_country <> btrim(p_country) or char_length(p_country) > 100
     ))
     or p_quantity is null or p_quantity not between 1 and 100000
     or p_unit_cost is null or p_unit_cost < 0 or p_unit_cost > 99999999.99 then
    raise exception using errcode = '22023', message = 'invalid cellar add input';
  end if;

  if not public.is_member_with_role(p_restaurant_id, 'manager') then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;

  -- This mirrors createIdempotencyRequestHash({ body }) exactly: sorted JSON
  -- fields with an eight-byte big-endian UTF-8 length prefix.
  v_identity :=
    '{"body":{"country":' || coalesce(pg_catalog.to_json(p_country)::text, 'null')
    || ',"name":' || pg_catalog.to_json(p_name)::text
    || ',"producer":' || pg_catalog.to_json(p_producer)::text
    || ',"quantity":' || pg_catalog.to_json(p_quantity)::text
    || ',"region":' || coalesce(pg_catalog.to_json(p_region)::text, 'null')
    || ',"unit_cost":' || pg_catalog.to_json(p_unit_cost)::text
    || ',"varietal":' || coalesce(pg_catalog.to_json(p_varietal)::text, 'null')
    || ',"vintage":' || coalesce(pg_catalog.to_json(p_vintage)::text, 'null')
    || '}}';
  v_computed_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.int8send(
        pg_catalog.octet_length(pg_catalog.convert_to(v_identity, 'UTF8'))::bigint
      ) || pg_catalog.convert_to(v_identity, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  if p_idempotency_key is null and p_request_hash is not null then
    raise exception using errcode = '22023', message = 'request hash requires an idempotency key';
  end if;

  if p_idempotency_key is not null then
    if p_request_hash is null or p_request_hash <> v_computed_hash then
      raise exception using errcode = '22023', message = 'request hash does not match the canonical cellar add identity';
    end if;

    select * into v_claim from public.claim_api_idempotency(
      p_restaurant_id,
      'api:POST:/api/cellar',
      p_idempotency_key,
      v_computed_hash
    );
    if v_claim.outcome = 'replay' then
      return query select 'replay'::text, v_claim.response_status, v_claim.response_body, true;
      return;
    elsif v_claim.outcome = 'in_progress' then
      return query select 'idempotency_in_progress'::text, 409,
        jsonb_build_object('error', jsonb_build_object(
          'code', 'idempotency_in_progress',
          'message', 'A request with this Idempotency-Key is still in progress.'
        )), false;
      return;
    elsif v_claim.outcome = 'mismatch' then
      return query select 'idempotency_key_reused'::text, 409,
        jsonb_build_object('error', jsonb_build_object(
          'code', 'idempotency_key_reused',
          'message', 'This Idempotency-Key was already used for a different request.'
        )), false;
      return;
    elsif v_claim.outcome = 'expired' then
      return query select 'idempotency_key_expired'::text, 409,
        jsonb_build_object('error', jsonb_build_object(
          'code', 'idempotency_key_expired',
          'message', 'This Idempotency-Key has expired.'
        )), false;
      return;
    elsif v_claim.outcome = 'outcome_unknown' then
      return query select 'idempotency_outcome_unknown'::text, 409,
        jsonb_build_object('error', jsonb_build_object(
          'code', 'idempotency_outcome_unknown',
          'message', 'The original request outcome is unknown and will not be retried.'
        )), false;
      return;
    elsif v_claim.outcome <> 'claimed' then
      raise exception using errcode = '40001', message = 'unexpected idempotency claim outcome';
    end if;
  end if;

  v_wine_ids := public.find_or_create_wines_batch(
    p_restaurant_id,
    jsonb_build_array(jsonb_build_object(
      'name', p_name,
      'producer', p_producer,
      'vintage', p_vintage,
      'varietal', p_varietal,
      'region', p_region,
      'country', p_country,
      'size_ml', 750
    ))
  );
  v_wine_id := v_wine_ids[1];
  if cardinality(v_wine_ids) <> 1 or v_wine_id is null then
    raise exception using errcode = 'P0001', message = 'find_or_create_wines_batch returned invalid IDs';
  end if;

  insert into public.inventory_items (
    wine_id, restaurant_id, quantity, unit_cost, added_via
  ) values (
    v_wine_id, p_restaurant_id, p_quantity, p_unit_cost, 'manual'
  ) returning * into v_inventory;

  v_body := jsonb_build_object(
    'wineId', v_wine_id,
    'inventoryId', v_inventory.id,
    'quantity', v_inventory.quantity,
    'unitCost', v_inventory.unit_cost
  );
  if p_idempotency_key is not null then
    v_completed := public.complete_api_idempotency(
      p_restaurant_id,
      'api:POST:/api/cellar',
      p_idempotency_key,
      v_computed_hash,
      200,
      '{}'::jsonb,
      v_body
    );
    if not v_completed then
      raise exception using errcode = '40001', message = 'idempotency completion changed concurrently';
    end if;
  end if;

  return query select 'added'::text, 200, v_body, false;
end;
$$;

create or replace function public.delete_cellar_wine_idempotent(
  p_restaurant_id uuid,
  p_wine_id uuid,
  p_idempotency_key text default null,
  p_request_hash text default null
) returns table (
  outcome text,
  response_status integer,
  response_body jsonb,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_claim record;
  v_wine public.wines%rowtype;
  v_identity text;
  v_computed_hash text;
  v_count bigint;
  v_body jsonb;
  v_completed boolean;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;
  if p_restaurant_id is null or p_wine_id is null then
    raise exception using errcode = '22023', message = 'restaurant_id and wine_id are required';
  end if;
  if not public.is_member_with_role(p_restaurant_id, 'owner') then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;

  v_identity := '{"id":' || pg_catalog.to_json(p_wine_id::text)::text || '}';
  v_computed_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.int8send(
        pg_catalog.octet_length(pg_catalog.convert_to(v_identity, 'UTF8'))::bigint
      ) || pg_catalog.convert_to(v_identity, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
  if p_idempotency_key is null and p_request_hash is not null then
    raise exception using errcode = '22023', message = 'request hash requires an idempotency key';
  end if;
  if p_idempotency_key is not null then
    if p_request_hash is null or p_request_hash <> v_computed_hash then
      raise exception using errcode = '22023', message = 'request hash does not match the canonical cellar deletion identity';
    end if;
    select * into v_claim from public.claim_api_idempotency(
      p_restaurant_id,
      'api:DELETE:/api/cellar/{param}',
      p_idempotency_key,
      v_computed_hash
    );
    if v_claim.outcome = 'replay' then
      return query select 'replay'::text, v_claim.response_status, v_claim.response_body, true;
      return;
    elsif v_claim.outcome = 'in_progress' then
      return query select 'idempotency_in_progress'::text, 409,
        jsonb_build_object('error', jsonb_build_object('code', 'idempotency_in_progress', 'message', 'A request with this Idempotency-Key is still in progress.')), false;
      return;
    elsif v_claim.outcome = 'mismatch' then
      return query select 'idempotency_key_reused'::text, 409,
        jsonb_build_object('error', jsonb_build_object('code', 'idempotency_key_reused', 'message', 'This Idempotency-Key was already used for a different request.')), false;
      return;
    elsif v_claim.outcome = 'expired' then
      return query select 'idempotency_key_expired'::text, 409,
        jsonb_build_object('error', jsonb_build_object('code', 'idempotency_key_expired', 'message', 'This Idempotency-Key has expired.')), false;
      return;
    elsif v_claim.outcome = 'outcome_unknown' then
      return query select 'idempotency_outcome_unknown'::text, 409,
        jsonb_build_object('error', jsonb_build_object('code', 'idempotency_outcome_unknown', 'message', 'The original request outcome is unknown and will not be retried.')), false;
      return;
    elsif v_claim.outcome <> 'claimed' then
      raise exception using errcode = '40001', message = 'unexpected idempotency claim outcome';
    end if;
  end if;

  -- FOR UPDATE blocks new FK references while the dependency checks and delete
  -- execute, preventing a check-then-delete race.
  select * into v_wine
  from public.wines
  where wines.id = p_wine_id and wines.restaurant_id = p_restaurant_id
  for update;
  if not found then
    v_body := jsonb_build_object('error', jsonb_build_object('code', 'not_found', 'message', 'Wine not found.'));
    if p_idempotency_key is not null then
      v_completed := public.complete_api_idempotency(p_restaurant_id, 'api:DELETE:/api/cellar/{param}', p_idempotency_key, v_computed_hash, 404, '{}'::jsonb, v_body);
      if not v_completed then raise exception using errcode = '40001', message = 'idempotency completion changed concurrently'; end if;
    end if;
    return query select 'not_found'::text, 404, v_body, false;
    return;
  end if;

  select count(*) into v_count from public.pour_events
  where pour_events.wine_id = p_wine_id and pour_events.restaurant_id = p_restaurant_id;
  if v_count > 0 then
    v_body := jsonb_build_object('error', jsonb_build_object('code', 'wine_has_pours', 'message', format('Cannot delete "%s %s" — it has %s pour event%s.', v_wine.producer, v_wine.name, v_count, case when v_count = 1 then '' else 's' end)));
    return query select * from public.complete_cellar_wine_delete_idempotency(p_restaurant_id, p_idempotency_key, v_computed_hash, 'wine_has_pours', v_body);
    return;
  end if;

  select count(*) into v_count from public.inventory_items
  where inventory_items.wine_id = p_wine_id and inventory_items.restaurant_id = p_restaurant_id;
  if v_count > 0 then
    v_body := jsonb_build_object('error', jsonb_build_object('code', 'wine_has_inventory', 'message', format('Cannot delete "%s %s" — it has %s inventory item%s. 86 the wine instead.', v_wine.producer, v_wine.name, v_count, case when v_count = 1 then '' else 's' end)));
    return query select * from public.complete_cellar_wine_delete_idempotency(p_restaurant_id, p_idempotency_key, v_computed_hash, 'wine_has_inventory', v_body);
    return;
  end if;

  select count(*) into v_count from public.wine_list_items
  where wine_list_items.wine_id = p_wine_id;
  if v_count > 0 then
    v_body := jsonb_build_object('error', jsonb_build_object('code', 'wine_on_lists', 'message', format('Cannot delete "%s %s" — it appears on %s wine list%s. Remove it from lists first.', v_wine.producer, v_wine.name, v_count, case when v_count = 1 then '' else 's' end)));
    return query select * from public.complete_cellar_wine_delete_idempotency(p_restaurant_id, p_idempotency_key, v_computed_hash, 'wine_on_lists', v_body);
    return;
  end if;

  select count(*) into v_count from public.invoice_scans
  where invoice_scans.restaurant_id = p_restaurant_id
    and invoice_scans.parsed_line_items @> jsonb_build_array(jsonb_build_object('name', v_wine.name));
  if v_count > 0 then
    v_body := jsonb_build_object('error', jsonb_build_object('code', 'wine_from_scan', 'message', format('Cannot delete "%s %s" — it was imported via %s invoice scan%s. Remove the scan record first.', v_wine.producer, v_wine.name, v_count, case when v_count = 1 then '' else 's' end)));
    return query select * from public.complete_cellar_wine_delete_idempotency(p_restaurant_id, p_idempotency_key, v_computed_hash, 'wine_from_scan', v_body);
    return;
  end if;

  delete from public.wines where wines.id = p_wine_id and wines.restaurant_id = p_restaurant_id;
  if not found then
    raise exception using errcode = '40001', message = 'cellar deletion target changed concurrently';
  end if;
  v_body := jsonb_build_object('deleted', true);
  if p_idempotency_key is not null then
    v_completed := public.complete_api_idempotency(p_restaurant_id, 'api:DELETE:/api/cellar/{param}', p_idempotency_key, v_computed_hash, 200, '{}'::jsonb, v_body);
    if not v_completed then raise exception using errcode = '40001', message = 'idempotency completion changed concurrently'; end if;
  end if;
  return query select 'deleted'::text, 200, v_body, false;
end;
$$;

-- Complete deterministic deletion denials inside the same transaction as the
-- claim. The helper preserves the keyless legacy responses without a record.
create or replace function public.complete_cellar_wine_delete_idempotency(
  p_restaurant_id uuid,
  p_idempotency_key text,
  p_request_hash text,
  p_outcome text,
  p_response_body jsonb
) returns table (
  outcome text,
  response_status integer,
  response_body jsonb,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_completed boolean;
begin
  if p_idempotency_key is not null then
    v_completed := public.complete_api_idempotency(
      p_restaurant_id, 'api:DELETE:/api/cellar/{param}', p_idempotency_key,
      p_request_hash, 409, '{}'::jsonb, p_response_body
    );
    if not v_completed then
      raise exception using errcode = '40001', message = 'idempotency completion changed concurrently';
    end if;
  end if;
  return query select p_outcome, 409, p_response_body, false;
end;
$$;

revoke all on function public.add_cellar_wine_idempotent(uuid,text,text,integer,text,text,text,integer,numeric,text,text) from public;
revoke all on function public.add_cellar_wine_idempotent(uuid,text,text,integer,text,text,text,integer,numeric,text,text) from anon;
grant execute on function public.add_cellar_wine_idempotent(uuid,text,text,integer,text,text,text,integer,numeric,text,text) to authenticated;
revoke all on function public.delete_cellar_wine_idempotent(uuid,uuid,text,text) from public;
revoke all on function public.delete_cellar_wine_idempotent(uuid,uuid,text,text) from anon;
grant execute on function public.delete_cellar_wine_idempotent(uuid,uuid,text,text) to authenticated;
revoke all on function public.complete_cellar_wine_delete_idempotency(uuid,text,text,text,jsonb) from public;
revoke all on function public.complete_cellar_wine_delete_idempotency(uuid,text,text,text,jsonb) from anon;

comment on function public.add_cellar_wine_idempotent(uuid,text,text,integer,text,text,text,integer,numeric,text,text) is
  'Atomically adds cellar inventory and stores or replays the exact keyed API response.';
comment on function public.delete_cellar_wine_idempotent(uuid,uuid,text,text) is
  'Atomically deletes an unreferenced cellar wine and stores or replays exact keyed outcomes.';
