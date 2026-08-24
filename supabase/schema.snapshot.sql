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

-- === 0077_inventory_fk_perf_indexes.sql ===
-- C12 (db audit 2026-08-23) — missing indexes on FK columns pointing at
-- inventory_items make revert_import_batch (0076) O(n) full-table scans
-- per reverted row, i.e. O(n * table_size) overall.
--
-- revert_import_batch loops once per applied row and issues
--   delete from public.inventory_items where id = ... ;
-- Every such delete makes Postgres check the two tables with an FK
-- pointing at inventory_items for referencing rows, regardless of the
-- ON DELETE action (SET NULL still has to find the rows to null out):
--   import_batch_rows.applied_inventory_item_id  (on delete set null)
--   open_bottles.source_inventory_item_id        (on delete set null)
-- Neither column had an index, so each FK-integrity check was a full
-- sequential scan of the child table — repeated once per deleted row.
--
-- Verified (.../scratchpad/db-audit/verify/V4-bottles.md, C12): at a
-- 15,001-row import_batch_rows table, EXPLAIN ANALYZE showed the
-- import_batch_rows FK-check trigger alone drop from 5.339ms to 0.078ms
-- (68x) once this index existed; pg_stat_user_tables showed exactly one
-- extra full sequential scan of import_batch_rows per deleted
-- inventory_items row (5,000 deletes -> 5,000 seq scans, ~50M tuples
-- read); a real 5,000-row revert_import_batch call (through the live
-- PostgREST RPC, as an authenticated tenant) dropped from 4,444ms to
-- 1,220ms (3.6x) with the index present, and the gap widens as
-- import_batch_rows grows, since it is an append-only audit trail that
-- is never deleted (rows are only ever flipped to 'reverted').
--
-- Both columns are nullable and populated in exactly one lifecycle
-- state (applied_inventory_item_id: only while apply_status =
-- 'applied'; source_inventory_item_id: only for a bottle opened from a
-- tracked inventory row), so a partial index — matching the auditors'
-- fix sketch — covers every row either the FK trigger or
-- revert_import_batch ever look up while staying small relative to the
-- full table.
--
-- Other unindexed FK columns exist elsewhere in this schema (e.g. the
-- *_by/*_user_id audit columns pointing at auth.users, and a handful of
-- wine_id FKs — see the fix-lane report for the full catalog query and
-- results). None of them sit behind a bulk per-row delete loop the way
-- inventory_items does under revert_import_batch: auth.users rows are
-- never bulk-deleted by any app write path, and the wines-table deletes
-- in merge_wines (0055) remove exactly one row per call, not N rows in
-- one transaction, so the O(n * table_size) pattern this migration
-- fixes does not apply to them. Left alone — no measurement or
-- reachable write path justifies indexing them right now.
--
-- Lock note: CREATE INDEX CONCURRENTLY cannot run inside a transaction
-- block, and — per the precedent in 0012_wine_list_items_wine_id_idx.sql
-- — this repo's migration runner (local `supabase db reset` and CI)
-- applies every migration inside one. This migration therefore uses the
-- plain (non-concurrent) form, matching that precedent; both tables are
-- a few thousand to ~20k rows in every environment this has been tested
-- against today, so the AccessExclusiveLock window is well under a
-- second. If this is ever applied by hand to a live database where
-- import_batch_rows/open_bottles have grown large enough that an
-- AccessExclusiveLock would be disruptive, an operator should instead
-- run the CONCURRENTLY form below manually, outside the normal
-- migration pipeline, before marking this migration applied:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS
--     import_batch_rows_applied_inventory_item_id_idx
--     ON public.import_batch_rows (applied_inventory_item_id)
--     WHERE applied_inventory_item_id IS NOT NULL;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS
--     open_bottles_source_inventory_item_id_idx
--     ON public.open_bottles (source_inventory_item_id)
--     WHERE source_inventory_item_id IS NOT NULL;
--
-- DOWN:
--   DROP INDEX IF EXISTS public.import_batch_rows_applied_inventory_item_id_idx;
--   DROP INDEX IF EXISTS public.open_bottles_source_inventory_item_id_idx;

create index if not exists import_batch_rows_applied_inventory_item_id_idx
  on public.import_batch_rows (applied_inventory_item_id)
  where applied_inventory_item_id is not null;

create index if not exists open_bottles_source_inventory_item_id_idx
  on public.open_bottles (source_inventory_item_id)
  where source_inventory_item_id is not null;

-- === 0078_match_lwin_trgm_fastpath.sql ===
-- C07 (db audit 2026-08-23) — match_lwin / match_lwin_batch (0007) filter
-- on similarity(lower(col), ...) >= threshold, which the planner cannot
-- push down through lwin_catalog's GIN trigram indexes (those only
-- support the pg_trgm %, <->, and LIKE-family operators, never a bare
-- similarity() call). Every match_lwin call therefore sequential-scans
-- the whole lwin_catalog table and evaluates similarity() per row.
--
-- Verified (.../scratchpad/db-audit/verify/V5-perf-static.md, C07): at a
-- ~130,000-row lwin_catalog, the shipped code's own LWIN_MATCH_BATCH_SIZE
-- (300 rows/RPC call, src/domains/import/constants.ts) took 28.7s per
-- match_lwin_bulk call — against the authenticated role's 8s
-- statement_timeout — and the live PostgREST RPC returned a real HTTP 500
-- (SQLSTATE 57014, "canceling statement due to statement timeout") for
-- every chunk. Reproduced independently in this fix lane against a fresh
-- ~130,000-row synthetic catalog: identical HTTP 500 / 57014 at 8.44s
-- wall clock via the live RPC as an authenticated tenant.
--
-- Fix: replace the un-indexable similarity()>=threshold producer
-- comparison with an indexed % prefilter (lower(producer) %
-- lower(p_producer)), gated by a TRANSACTION-LOCAL setting of
-- pg_trgm.similarity_threshold — set_config(..., true), deliberately NOT
-- pg_trgm's own set_limit(), which sets a SESSION-scoped GUC via a plain
-- SET and would leak one caller's threshold into a later request that
-- reuses the same pooled connection. is_local = true reverts
-- automatically at the end of the calling transaction (one PostgREST
-- request = one transaction), so concurrent callers can never see each
-- other's threshold.
--
-- % is defined as similarity(a,b) >= the GUC value — verified empirically
-- in this lane (similarity(a,b) == GUC still evaluates % to true, i.e.
-- the boundary is >=, matching the original inline comparison exactly,
-- not a stricter >). That makes lower(lc.producer) % lower(p_producer)
-- (with the GUC set to p_threshold) an exact, index-eligible restatement
-- of the producer half of the original predicate — not an approximation.
--
-- Both original similarity() >= comparisons — producer AND name, at
-- their ORIGINAL two different thresholds (p_threshold and
-- p_threshold * 0.7) — are kept verbatim as residual filters after the %
-- prefilter. This is deliberate belt-and-suspenders: the % prefilter can
-- only narrow the candidate set that reaches those exact, unchanged
-- filters, so the returned match set is provably identical to the
-- original function's, regardless of any edge case in the operator's
-- floating-point boundary. Match-set equivalence was verified over 5,505
-- query pairs (exact catalog rows, case/typo/truncation variants, and
-- pure no-match garbage) against a ~130,000-row synthetic catalog,
-- comparing the OLD predicate shape and the NEW one row by row — see the
-- fix-lane report for the exact count and an explicit before/after check
-- of the C24 Pichon Baron / Pichon Lalande case (unchanged by this fix,
-- as required — C24 is a threshold/semantics bug owned by a different
-- fix lane; this migration does not touch match-acceptance semantics).
--
-- A second index on lower(display_name), used as a second % prefilter
-- ANDed via BitmapAnd, was tried and measured SLOWER in this lane's
-- testing: the shared GUC value needed to keep it a safe, no-false-
-- negative prefilter for the *name* comparison (p_threshold * 0.7, the
-- looser of the two thresholds) also loosens the *producer* prefilter,
-- and that lost more selectivity than the second index recovered. It
-- was dropped; only the producer index is added here.
--
-- match_lwin moves from `stable` to (implicitly) `volatile`: it now has
-- one side effect, a transaction-local GUC set, so `stable` would no
-- longer be an accurate declaration. This does not change how many
-- times per-row callers (match_lwin_bulk's LATERAL join, match_lwin_batch's
-- loop) invoke it — both already call it once per row with different
-- arguments every time, regardless of volatility.
--
-- Batch-size note: even with this fix, an adversarial worst case — every
-- row in one chunk sharing a very common producer-name word (e.g.
-- "Domaine", "Chateau") — can still approach the 8s budget at the
-- shipped LWIN_MATCH_BATCH_SIZE of 300 (measured ~12s for an
-- all-common-prefix 300-row batch against the same synthetic catalog;
-- ~4.4s for the same shape at 100 rows). This migration only touches the
-- database — src/domains/import/constants.ts is updated in the same fix
-- commit to reduce LWIN_MATCH_BATCH_SIZE so that worst case stays safely
-- inside the timeout; see the fix-lane report for the full measurements.
--
-- DOWN:
--   Restores the pre-fix match_lwin body (0007) verbatim and drops the
--   new index. See down/0078_match_lwin_trgm_fastpath.down.sql.

create index if not exists lwin_catalog_producer_lower_trgm_idx
  on public.lwin_catalog using gin (lower(producer) gin_trgm_ops);

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
language sql security definer set search_path = public
as $$
  select set_config('pg_trgm.similarity_threshold', p_threshold::text, true);
  select lc.lwin_id, lc.display_name, lc.producer, lc.varietal,
         lc.region, lc.country, lc.colour,
         (similarity(lower(p_producer), lower(lc.producer)) * 0.6 +
          similarity(lower(p_name), lower(lc.display_name)) * 0.4) as score
  from public.lwin_catalog lc
  where lower(lc.producer) % lower(p_producer)
    and similarity(lower(p_producer), lower(lc.producer)) >= p_threshold
    and similarity(lower(p_name), lower(lc.display_name)) >= p_threshold * 0.7
  order by score desc
  limit 1;
$$;

revoke all on function public.match_lwin(text, text, float) from public;
grant execute on function public.match_lwin(text, text, float) to authenticated;

-- === 0079_wine_rpc_invoker_boundary.sql ===
-- 0079_wine_rpc_invoker_boundary.sql
--
-- C01 (db audit 2026-08-23) — find_or_create_wine, find_or_create_wines_batch,
-- and match_lwin_batch are SECURITY DEFINER and trust a caller-supplied
-- p_restaurant_id / p_wine_ids with zero membership check. PostgREST grants
-- EXECUTE on all three to `authenticated` (not just service_role), and
-- signup is self-service (handle_new_user provisions a fresh restaurant +
-- owner membership for anyone who registers an email) — so "authenticated"
-- here means any signed-up user of any tenant, not a privileged app role.
--
-- Verified (.../scratchpad/db-audit/verify/V1-tenancy.md, C01): a tenant-B
-- session called all three RPCs against tenant A's restaurant_id / wine ids
-- and wrote/mutated tenant A's catalog rows every time — HTTP 200, confirmed
-- as superuser afterward. Anon correctly 401s (no EXECUTE grant to anon),
-- so PostgREST-as-authenticated is the entire reachable surface.
--
-- Fix: convert all three from SECURITY DEFINER to SECURITY INVOKER instead
-- of bolting an explicit is_member() guard onto each. `wines` already has
-- complete, correct RLS (members-only select/insert/update/delete, keyed on
-- is_member(restaurant_id)) — as SECURITY INVOKER, every SELECT/INSERT/
-- UPDATE these functions perform against wines is subject to that RLS for
-- the ACTUAL calling role, so:
--   - a member's own restaurant: identical behavior to before (their own
--     grants + RLS already allow everything these functions do).
--   - a non-member's restaurant_id: the INSERT/UPDATE inside the function
--     hits the WITH CHECK/USING clause and fails with 42501 ("new row
--     violates row-level security policy"), atomically — no partial
--     writes, no silent cross-tenant landing.
--   - match_lwin_batch's driving SELECT ... WHERE id = ANY(p_wine_ids) is
--     itself RLS-filtered, so a foreign wine id is simply invisible to the
--     loop rather than needing a hand-rolled membership join — the same
--     "invisible, not rejected" idiom apply_import_batch_chunk (0076)
--     already uses for exactly this shape of problem.
-- Converting to INVOKER is preferred over an explicit per-function guard:
-- it can't drift out of sync with wines' own policies, and it is enforced
-- on every statement inside the function, not just a single top-of-function
-- check.
--
-- match_lwin (called from inside match_lwin_batch) stays SECURITY DEFINER,
-- unchanged — it reads the global, non-tenant-scoped lwin_catalog reference
-- table, a separate, already-reviewed surface (0007/0078) untouched here.
--
-- DOWN: restores all three functions' pre-fix SECURITY DEFINER bodies
-- verbatim (0002 for find_or_create_wine, 0006 for find_or_create_wines_batch,
-- 0007 for match_lwin_batch — 0078 only replaced match_lwin's body, never
-- match_lwin_batch's). See down/0079_wine_rpc_invoker_boundary.down.sql.

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
security invoker
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

create or replace function public.find_or_create_wines_batch(
  p_restaurant_id uuid,
  p_wines         jsonb
)
returns uuid[]
language plpgsql
security invoker
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

create or replace function public.match_lwin_batch(p_wine_ids uuid[])
returns table (wine_id uuid, lwin_id text, score float)
language plpgsql security invoker set search_path = public
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

-- === 0080_wine_list_items_tenant_fk.sql ===
-- 0080_wine_list_items_tenant_fk.sql
--
-- C05 (db audit 2026-08-23) — the wine_list_items INSERT/UPDATE policies
-- validate only the SECTION's tenant (via section_id -> wine_list_sections
-- -> wine_lists.restaurant_id), never the WINE's. wine_id and section_id
-- are two independent foreign keys with no relationship enforced between
-- their tenants.
--
-- Verified (.../scratchpad/db-audit/verify/V1-tenancy.md, C05): cross-
-- tenant insert succeeded in BOTH directions (201 Created, no FK/RLS
-- rejection), and linking tenant A's private (never-published) wine into
-- tenant B's published list made it anonymously readable — proven with a
-- real anon GET before (empty) and after (A's wine, full price fields)
-- publishing B's list. No compromise of A's account required, only
-- knowledge of A's wine UUID — and C01's now-fixed open catalog-write RPCs
-- previously meant an attacker didn't even need a leaked id.
--
-- Fix, two independent layers matching the fix sketch:
--
--  1. Denormalize restaurant_id onto wine_list_items, matching
--     wines.restaurant_id, enforced by a COMPOSITE FK to a new
--     wines(id, restaurant_id) unique constraint. This makes "this item's
--     restaurant_id equals its wine's real restaurant_id" a hard schema
--     invariant — true regardless of RLS, and even for a future
--     SECURITY DEFINER path that bypasses RLS entirely.
--
--  2. wine_list_sections has no restaurant_id column of its own (it is one
--     join further from restaurants than wine_list_items), so "this item's
--     restaurant_id equals its SECTION's real restaurant_id" cannot be
--     expressed as a second composite FK — a composite FK can only pin a
--     column to a value that literally exists in another table's unique
--     key, not to a value derived via a join. That side is enforced by a
--     BEFORE INSERT/UPDATE trigger that resolves the section's restaurant
--     via wine_list_sections -> wine_lists and rejects any mismatch. Same
--     "pure data-integrity check, not a permission gate" shape as
--     derive_wine_lineage (0054) — SECURITY DEFINER so it resolves the
--     section's true restaurant deterministically regardless of the
--     caller's own RLS visibility into wine_list_sections, rather than
--     the "NOT SECURITY DEFINER, needs current_user" shape of the owner-
--     only triggers (0022/0023), which are role checks, not data checks.
--
-- With both layers in place, both attack directions the verifier ran are
-- closed: attaching A's wine into B's section requires restaurant_id to
-- equal A's wine's restaurant (composite FK) AND B's section's restaurant
-- (trigger) simultaneously — impossible unless A and B are the same
-- tenant. The INSERT/UPDATE RLS policies are also updated to check the
-- new column directly (`is_member(restaurant_id)` plus a section-restaurant
-- match), so the common case still fails with a clean RLS 42501 before
-- ever reaching the trigger or the FK.
--
-- Deliberately NOT touched: the SELECT policies (including C06's anon
-- "published list items are public" hidden-column fix, and the read/delete
-- policies' existing section-join shape) — out of this cluster's scope.
-- Once this migration lands, a mismatched wine/section pairing can no
-- longer be CREATED, which is what made C06's hidden-item leak scenario
-- reachable in the first place; C06's own migration fixes the independent
-- hidden-bypass bug on its own terms.
--
-- Lock note: wines and wine_list_items are both expected to be small
-- (hundreds to low thousands of rows per tenant) at this stage — the ALTER
-- TABLE ADD CONSTRAINT / backfill UPDATE here take a plain ACCESS EXCLUSIVE
-- lock for the duration of a full-table scan, acceptable at current scale.
-- If either table is materially larger by the time this runs against a
-- real environment, backfill in batches and add the FK as NOT VALID +
-- VALIDATE CONSTRAINT (a separate, non-blocking step) instead.
--
-- DOWN: drops the trigger, the composite FK, the column, and the wines
-- uniqueness constraint, and restores the pre-fix INSERT/UPDATE policies
-- verbatim. See down/0080_wine_list_items_tenant_fk.down.sql.

-- ── 1. wines(id, restaurant_id) — composite FK target ──────────────────
-- id alone is already globally unique (primary key), so this adds no new
-- restriction on wines data; it exists purely so wine_list_items can FK
-- against the (id, restaurant_id) pair.
alter table public.wines
  add constraint wines_id_restaurant_id_key unique (id, restaurant_id);

-- ── 2. wine_list_items.restaurant_id — denormalized, backfilled, FK'd ──
alter table public.wine_list_items
  add column restaurant_id uuid references public.restaurants(id) on delete cascade;

update public.wine_list_items wli
set restaurant_id = w.restaurant_id
from public.wines w
where w.id = wli.wine_id
  and wli.restaurant_id is null;

alter table public.wine_list_items
  alter column restaurant_id set not null;

alter table public.wine_list_items
  add constraint wine_list_items_wine_restaurant_fkey
  foreign key (wine_id, restaurant_id) references public.wines (id, restaurant_id)
  on delete restrict;

comment on column public.wine_list_items.restaurant_id is
  'C05 (db audit 2026-08-23): denormalized from wines.restaurant_id, enforced '
  'by the composite FK wine_list_items_wine_restaurant_fkey — a row can never '
  'reference a wine belonging to a different restaurant. Combined with the '
  'wine_list_items_enforce_section_restaurant trigger (which checks the '
  'section side of the same invariant) and the updated insert/update RLS '
  'policies below, this closes the cross-tenant wine/section linkage bug.';

-- ── 3. Section-side invariant: restaurant_id must match the section's ──
create or replace function public.wine_list_items_enforce_section_restaurant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_section_restaurant_id uuid;
begin
  select wl.restaurant_id into v_section_restaurant_id
  from public.wine_list_sections s
  join public.wine_lists wl on wl.id = s.wine_list_id
  where s.id = new.section_id;

  if v_section_restaurant_id is null then
    raise exception 'wine_list_items.section_id % does not resolve to a restaurant', new.section_id
      using errcode = '23503';
  end if;

  if v_section_restaurant_id <> new.restaurant_id then
    raise exception
      'wine_list_items.restaurant_id (%) does not match its section''s restaurant (%)',
      new.restaurant_id, v_section_restaurant_id
      using errcode = '23514';
  end if;

  return new;
end;
$$;

comment on function public.wine_list_items_enforce_section_restaurant() is
  'C05 (db audit 2026-08-23): BEFORE INSERT/UPDATE guard — resolves section_id''s '
  'real restaurant via wine_list_sections -> wine_lists and rejects any row whose '
  'restaurant_id disagrees. SECURITY DEFINER so the check is deterministic '
  'regardless of the caller''s own RLS visibility into wine_list_sections '
  '(a pure data-integrity check, not a role/permission gate).';

create trigger wine_list_items_enforce_section_restaurant
  before insert or update of section_id, restaurant_id on public.wine_list_items
  for each row execute function public.wine_list_items_enforce_section_restaurant();

-- ── 4. INSERT/UPDATE RLS policies now check both sides directly ────────
drop policy "members can insert list items" on public.wine_list_items;
create policy "members can insert list items"
  on public.wine_list_items for insert to authenticated
  with check (
    public.is_member(restaurant_id)
    and exists (
      select 1 from public.wine_list_sections s
      join public.wine_lists wl on wl.id = s.wine_list_id
      where s.id = section_id and wl.restaurant_id = restaurant_id
    )
  );

drop policy "members can update their list items" on public.wine_list_items;
create policy "members can update their list items"
  on public.wine_list_items for update to authenticated
  using (exists (
    select 1 from public.wine_list_sections s
    join public.wine_lists wl on wl.id = s.wine_list_id
    where s.id = section_id and public.is_member(wl.restaurant_id)
  ))
  with check (
    public.is_member(restaurant_id)
    and exists (
      select 1 from public.wine_list_sections s
      join public.wine_lists wl on wl.id = s.wine_list_id
      where s.id = section_id and wl.restaurant_id = restaurant_id
    )
  );

-- === 0081_anon_column_scoping.sql ===
-- 0081_anon_column_scoping.sql
--
-- C06 (db audit 2026-08-23) — 0074_public_api_grants.sql gave `anon` full
-- table-level SELECT (all columns, no column-level grant) on restaurants
-- and wines. RLS is row-level only, so a `select=*` request against the
-- raw Data API (not the SSR page's own curated column list) returns every
-- column for any row the row policy allows — including internal
-- pricing-strategy and ops-tuning columns no anon consumer needs.
--
-- Verified (.../scratchpad/db-audit/verify/V1-tenancy.md, C06): anon
-- `select=*` on a published wine returned pricing_target_pour_cost_pct,
-- pricing_target_markup_ratio, pricing_dismissed_until, retail_min/max/
-- median/retailer_count/refreshed_at, manual_overrides, and overpaid_flag;
-- on the restaurant row it returned auto_eightysix_from_inventory,
-- eightysix_ml_threshold, default_target_pour_cost_pct, and
-- default_target_markup_ratio. Separately, a wine_list_items row with
-- hidden = true remained anon-readable with full price fields, because
-- the "published list items are public" policy never checked `hidden`.
--
-- Correction the verifier made to the original claim: actual cost basis
-- (inventory_items.unit_cost) is NOT anon-exposed — inventory_items has no
-- anon grant at all (0074 only lists restaurants/wine_lists/
-- wine_list_sections/wine_list_items/wines). What leaks is pricing
-- *strategy* metadata and hidden items, not raw COGS. This migration does
-- not touch inventory_items.
--
-- Anon read-path audit (required before narrowing anon access — see the
-- fix-lane brief): grepped the whole app for every anon/public Supabase
-- client construction (`createAnonClient` / `getSupabasePublicConfig`,
-- excluding proxy.ts which only refreshes sessions, never queries data).
-- Exactly two consumers of wines/restaurants columns exist:
--   - src/app/list/[slug]/page.tsx        (public menu + its metadata)
--   - src/app/list/[slug]/print/page.tsx  (print view + its metadata)
-- Both select the *same* wines columns (id, name, producer, vintage,
-- varietal, region, serving_temp_min, serving_temp_max,
-- serving_temp_label, is_eightysixed) and the same restaurants columns
-- (name, eightysix_strategy, logo_url) — no other anon path touches these
-- tables. list/[slug]/page.tsx's own bin-code lookup uses the SERVICE ROLE
-- client already (fetchPublicBinCodes), not anon — untouched here.
--
-- eightysix_strategy is deliberately KEPT anon-readable even though the
-- original audit grouped it with "internal ops intelligence": the public
-- page reads it directly to decide whether to hide or mark 86'd items
-- (`eightysixStrategy = restaurant?.eightysix_strategy === "mark" ? ... `)
-- — removing it would break the public menu's own rendering. Only the
-- genuinely internal, anon-unused sibling knobs (eightysix_ml_threshold,
-- auto_eightysix_from_inventory, default_target_pour_cost_pct,
-- default_target_markup_ratio) are excluded.
--
-- Fix: revoke anon's table-level SELECT on wines and restaurants, replace
-- with column-level SELECT grants covering exactly the columns above (plus
-- each table's `id`, required for PostgREST's FK-embed join condition —
-- Postgres column privileges cover columns used in a join's ON/WHERE
-- condition, not only the output list). This is transparent to PostgREST's
-- embedding (same FK graph, same table names — no application code
-- change) and to every existing anon query, which already only names
-- these columns; it only blocks `select=*` / explicit-other-column
-- requests against the raw Data API. wine_lists and wine_list_sections
-- keep their existing full table-level anon grant unchanged — neither has
-- any pricing/ops column, only display config (name, template, slug,
-- is_published, position, etc.).
--
-- wine_list_items keeps its table-level anon grant too (no sensitive
-- columns there — glass_price/bottle_price ARE the customer-facing menu
-- prices) but gets its SELECT policy's predicate fixed to also require
-- hidden = false, closing the second, independent leak. The app's SSR
-- page already filters `!item.hidden` client-side after fetching; this
-- makes that filtering also true at the RLS level, closing the raw-API
-- bypass without changing what the rendered page shows.
--
-- DOWN: restores the original blanket anon table-level SELECT on wines
-- and restaurants, and the pre-fix wine_list_items anon policy (no hidden
-- check). See down/0081_anon_column_scoping.down.sql.

revoke select on table public.wines, public.restaurants from anon;

grant select (
  id, name, producer, vintage, varietal, region,
  serving_temp_min, serving_temp_max, serving_temp_label, is_eightysixed
) on public.wines to anon;

grant select (
  id, name, eightysix_strategy, logo_url
) on public.restaurants to anon;

drop policy "published list items are public" on public.wine_list_items;
create policy "published list items are public"
  on public.wine_list_items for select to anon
  using (
    hidden = false
    and exists (
      select 1 from public.wine_list_sections s
      join public.wine_lists wl on wl.id = s.wine_list_id
      where s.id = section_id and wl.is_published = true
    )
  );

-- === 0082_import_batch_rows_tenant_fk.sql ===
-- 0082_import_batch_rows_tenant_fk.sql
--
-- C17 (db audit 2026-08-23) — import_batch_rows.batch_id and .restaurant_id
-- are two INDEPENDENT foreign keys (batch_id -> import_batches(id),
-- restaurant_id -> restaurants(id)) with no relationship enforced between
-- them. The INSERT policy validates only the row's own restaurant_id
-- (`is_member_with_role(restaurant_id, 'staff')`), never that batch_id
-- actually belongs to that restaurant.
--
-- Verified (.../scratchpad/db-audit/verify/V1-tenancy.md, C17), practical
-- blast radius corrected from the original claim: this is a DoS on a
-- VICTIM's own bulk-import confirm step, reachable by ANY authenticated
-- user with ZERO membership in the victim tenant — not only a dual-
-- membership scenario. ownerB (no membership in restaurant A) inserted a
-- row into A's real batch tagged with B's OWN restaurant_id at
-- row_number = 1 (201 Created — RLS only checked restaurant_id = B, which
-- passed for B). ownerA's subsequent real CSV-confirm insert (their own
-- rows 1-3) then failed outright: 409 Conflict, 23505 unique violation on
-- `import_batch_rows_batch_id_row_number_key`, because a stranger had
-- already occupied row_number = 1 in A's batch. batch_id is not a secret —
-- it's returned directly on batch creation and visible in any browser
-- network tab during the real confirm flow — so this needs no privileged
-- access, only observing or guessing a UUID. Separately, ownerB could call
-- apply_import_batch_chunk('<A_batch>') and have it process B's own
-- poison row as a "borrowed" container, even though the resulting write
-- still landed correctly under B (apply_import_batch_chunk is SECURITY
-- INVOKER, so RLS still scoped that specific write to B).
--
-- Fix, per the fix sketch:
--   1. UNIQUE (id, restaurant_id) on import_batches (id is already the
--      primary key, so this restricts nothing new — it exists purely to
--      be a composite FK target).
--   2. Replace import_batch_rows' two independent FKs
--      (import_batch_rows_batch_id_fkey, import_batch_rows_restaurant_id_fkey)
--      with ONE composite FK: (batch_id, restaurant_id) REFERENCES
--      import_batches (id, restaurant_id). This makes "this row's
--      restaurant_id equals its batch's real restaurant_id" a hard schema
--      invariant, independent of RLS — the exact poison-row insert the
--      verifier ran (batch_id = A's batch, restaurant_id = B) can no
--      longer succeed: (A_batch_id, B) does not exist as a pair in
--      import_batches, because import_batches' own row for A_batch has
--      restaurant_id = A. restaurant_id's referential integrity (must be
--      a real restaurants.id) is preserved transitively — import_batches
--      itself keeps its own restaurant_id -> restaurants(id) FK, unchanged.
--   3. apply_import_batch_chunk re-validates the batch's own tenant before
--      processing (belt-and-suspenders — with the composite FK in place, a
--      poison row across tenants can no longer exist, so this mainly turns
--      a silent "processed zero rows" no-op for a non-member's batch id
--      into an explicit, actionable error). Uses the exact same "RLS
--      already filtered this to batches I'm a member of — a cross-tenant
--      id is indistinguishable from a nonexistent one" idiom
--      revert_import_batch (0076) already established for this table.
--
-- If any existing row in import_batch_rows already violates the new
-- invariant (its restaurant_id disagrees with its batch's), the ADD
-- CONSTRAINT step below fails loudly — that is the intended behavior: it
-- means a real data-integrity problem exists and must be investigated
-- before the schema can safely lock it down, not something this migration
-- should silently paper over.
--
-- Lock note: import_batches/import_batch_rows are expected to be small
-- (bulk-import metadata, not the 20k-row inventory itself) at this stage —
-- the ADD CONSTRAINT here takes a brief ACCESS EXCLUSIVE lock for a
-- full-table validation scan, acceptable at current scale. If either table
-- grows materially, add the FK as NOT VALID + a separate VALIDATE
-- CONSTRAINT step instead.
--
-- DOWN: drops the composite FK and the import_batches uniqueness
-- constraint, restores the two independent FKs, and restores
-- apply_import_batch_chunk's pre-fix body. See
-- down/0082_import_batch_rows_tenant_fk.down.sql.

-- ── 1. import_batches(id, restaurant_id) — composite FK target ─────────
alter table public.import_batches
  add constraint import_batches_id_restaurant_id_key unique (id, restaurant_id);

-- ── 2. import_batch_rows: one composite FK instead of two independent ──
alter table public.import_batch_rows
  drop constraint import_batch_rows_batch_id_fkey,
  drop constraint import_batch_rows_restaurant_id_fkey,
  add constraint import_batch_rows_batch_restaurant_fkey
    foreign key (batch_id, restaurant_id)
    references public.import_batches (id, restaurant_id)
    on delete cascade;

comment on constraint import_batch_rows_batch_restaurant_fkey on public.import_batch_rows is
  'C17 (db audit 2026-08-23): replaces the old independent batch_id/'
  'restaurant_id FKs. Forces every row''s restaurant_id to match its '
  'batch''s real restaurant_id — a cross-tenant "poison row" (real batch, '
  'wrong tenant) can no longer be inserted, regardless of RLS.';

-- ── 3. apply_import_batch_chunk: re-validate the batch's own tenant ────
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
  -- C17: re-validate the batch's own tenant before processing any rows.
  -- RLS on import_batches already filters this to "batches I'm a member
  -- of" (the same idiom revert_import_batch, 0076, uses) — a batch id
  -- belonging to another restaurant is simply invisible here, which reads
  -- identically to a nonexistent one. With the composite FK added by this
  -- migration, a row whose restaurant_id disagrees with its batch's can
  -- no longer exist in the first place, so this is defense in depth: it
  -- turns what would otherwise be a silent "processed zero rows" no-op
  -- for a non-member's batch id into an explicit, actionable error.
  if not exists (select 1 from public.import_batches where id = p_batch_id) then
    raise exception 'import batch % not found', p_batch_id using errcode = 'P0002';
  end if;

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
  'batch. C17 (db audit 2026-08-23): re-validates the batch itself is '
  'visible (member of its restaurant) before processing any rows. FOR '
  'UPDATE SKIP LOCKED means concurrent/duplicate calls for the same batch '
  'never double-apply a row. Each row''s wine-lookup + inventory-insert + '
  'row-status-update is wrapped in its own exception block, so a single '
  'row failing never blocks or half-applies the others — call again to '
  'retry whatever remains not_applied. SECURITY INVOKER: RLS on '
  'import_batch_rows/wines/inventory_items is the tenant boundary, so a '
  'batch id from another restaurant is simply invisible to the initial '
  'SELECT and the loop does nothing.';

revoke all on function public.apply_import_batch_chunk(uuid, integer) from public;
grant execute on function public.apply_import_batch_chunk(uuid, integer) to authenticated;

-- === 0083_background_jobs_enqueue_rpc.sql ===
-- 0083_background_jobs_enqueue_rpc.sql
--
-- C20 (db audit 2026-08-23) — background_jobs' INSERT policy
-- (`is_member_with_role(restaurant_id, 'staff') and created_by = auth.uid()`)
-- applies zero guardrails on anything else in the row: idempotency_key,
-- max_attempts, run_after, and status are all caller-controlled.
--
-- Verified (.../scratchpad/db-audit/verify/V1-tenancy.md, C20), mechanism
-- corrected from the original claim: the DB layer applies zero guardrails
-- (ownership, scheduling, retry caps, idempotency-key integrity) on a
-- direct insert; the worker's own tenant-fetch check in
-- invoice-extract-handler.ts (not RLS, not the DB) is what limits blast
-- radius for a *forged* subject_id, and it does nothing for a *real* one.
-- A freshly created, lowest-privilege `staff` member (the floor of
-- is_member_with_role, not a distinct restriction) inserted a live
-- invoice_extract job with a forged idempotency_key (defeating the
-- database's only double-bill guard, background_jobs_idempotency_key_uniq),
-- max_attempts = 1000 against an app default of 5, and run_after in 1970
-- (immediately runnable) — 201 Created, and claim_invoice_extract_job
-- (simulated as service_role, exactly as the real worker would) picked it
-- up immediately. The reachable exploit is not "forge someone else's
-- data" (invoice-extract-handler.ts's tenant-fetch check does stop that);
-- it's a low-privilege staff member enqueueing their OWN tenant's real,
-- RLS-visible invoice_scans rows directly, bypassing the app's sanctioned
-- enqueue path (src/lib/jobs/enqueue.ts) entirely — multiplying real paid
-- Anthropic/OCR calls per scan past the idempotency guarantee, inflating
-- retries 200x past the designed cap, and (via claim's global,
-- non-tenant-scoped FIFO) monopolizing the shared queue.
--
-- Context: a separate verification lane established this whole subsystem
-- has ZERO live callers in src/app today (enqueueInvoiceExtractJob is
-- called from nowhere yet) — this is real, imminent infrastructure, not
-- yet wired to a route. Fixed properly below; deliberately NOT gold-plated
-- (see the migration's tail comment for what is left for whoever wires it
-- up next).
--
-- Fix, per the fix sketch:
--   1. Deny `authenticated` INSERT/UPDATE/DELETE on background_jobs
--      entirely — drop the old permissive INSERT policy and revoke the
--      table-level grants (0074 gave insert/update/delete blanket to
--      authenticated on all tables; there was never an UPDATE or DELETE
--      policy for this table, so this mainly formalizes what RLS already
--      denied for those two, and closes the one real gap: INSERT).
--   2. Route all enqueueing through `enqueue_invoice_extract_job`, a new
--      SECURITY DEFINER RPC that: verifies the caller is a staff-or-above
--      member of p_restaurant_id; verifies p_scan_id is a real
--      invoice_scans row that actually belongs to p_restaurant_id (subject
--      ownership, same tenant-fetch shape invoice-extract-handler.ts
--      already uses); pins idempotency_key = p_scan_id and created_by =
--      auth.uid() (both now ignore any caller-supplied value — there is no
--      such parameter); forces max_attempts to the constant default
--      (5 — must track DEFAULT_MAX_ATTEMPTS in
--      src/lib/jobs/constants.ts if that ever changes); and ignores
--      caller-supplied run_after/status entirely (always 'queued', always
--      run_after = now()). Preserves the existing revive-a-dead-job
--      behavior enqueue.ts implemented client-side, now atomic and
--      server-side.
--   3. Give claim_invoice_extract_job a per-tenant fairness bound: no more
--      than 3 invoice_extract jobs from the same restaurant may be
--      'processing' at once — a tenant with many queued jobs can no
--      longer occupy every worker slot simultaneously and starve every
--      other tenant's queue. Kept as an in-body constant, not a new
--      parameter: adding a parameter would change the function's
--      signature and `create or replace function` cannot alter an
--      existing function's parameter list in place (it would silently
--      create a SECOND overload alongside the original text-only one,
--      leaving the old, fairness-free version still callable under the
--      same name) — same signature avoids that hazard and needs no
--      change to claim.ts.
--
-- src/lib/jobs/enqueue.ts and its test are updated in this same fix
-- commit to call the new RPC instead of inserting/updating background_jobs
-- directly (that file's raw table access would otherwise silently break
-- the instant this migration's REVOKE lands, for whichever future caller
-- wires it up with a normal per-request authenticated client). Every OTHER
-- consumer of background_jobs is untouched and unaffected by the REVOKE:
--   - pricing_recommendations/cellar_health recompute
--     (src/lib/pricing-recommendations/recompute.ts,
--     src/lib/cellar-health/recompute.ts) already insert/update
--     background_jobs exclusively through a SERVICE-ROLE admin client
--     (src/app/api/pricing-recommendations/recompute/route.ts,
--     src/app/api/cellar-health/recompute/route.ts) — service_role
--     bypasses RLS and table grants entirely, so it is untouched by this
--     REVOKE regardless of job_type.
--   - claim_invoice_extract_job / reclaim_stuck_invoice_extract_jobs are
--     already granted to service_role ONLY (0075) — an authenticated-role
--     client gets permission-denied calling either, so the worker's own
--     claim -> complete/heartbeat chain (src/lib/jobs/claim.ts,
--     complete.ts, heartbeat.ts, reclaim.ts, run-once.ts) can only ever
--     run with a service-role client structurally, before and after this
--     migration — their raw background_jobs UPDATE calls are therefore
--     also unaffected.
--
-- Deliberately left for whoever wires this feature up (not gold-plated
-- here): reclaim_stuck_invoice_extract_jobs' own requeue does not re-apply
-- the fairness cap (a reclaimed job just goes back to 'queued' and
-- competes normally on the next claim); the fairness constant (3) is a
-- starting point, not a tuned value — there is no production traffic yet
-- to tune it against; and no route/UI exists yet to call
-- enqueue_invoice_extract_job at all.
--
-- DOWN: restores the pre-fix INSERT policy and table grants, drops
-- enqueue_invoice_extract_job, and restores claim_invoice_extract_job's
-- pre-fix (no fairness cap) body. See
-- down/0083_background_jobs_enqueue_rpc.down.sql.

-- ── 1. Deny authenticated direct writes on background_jobs ─────────────
drop policy "members can create own background jobs" on public.background_jobs;

revoke insert, update, delete on public.background_jobs from authenticated;

-- ── 2. Sanctioned enqueue path ───────────────────────────────────────────
create or replace function public.enqueue_invoice_extract_job(
  p_restaurant_id uuid,
  p_scan_id       uuid
)
returns table (job_id uuid, created boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_job_id  uuid;
  v_status  text;
begin
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if not public.is_member_with_role(p_restaurant_id, 'staff') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Subject ownership: p_scan_id must be a real invoice_scans row that
  -- actually belongs to p_restaurant_id — the same tenant-fetch shape
  -- invoice-extract-handler.ts already applies before any provider call.
  if not exists (
    select 1 from public.invoice_scans
    where id = p_scan_id and restaurant_id = p_restaurant_id
  ) then
    raise exception 'invoice scan % not found for restaurant %', p_scan_id, p_restaurant_id
      using errcode = 'P0002';
  end if;

  begin
    insert into public.background_jobs (
      restaurant_id, created_by, job_type, status,
      subject_table, subject_id, idempotency_key, max_attempts, run_after
    ) values (
      p_restaurant_id, v_user_id, 'invoice_extract', 'queued',
      'invoice_scans', p_scan_id, p_scan_id::text,
      5, -- DEFAULT_MAX_ATTEMPTS in src/lib/jobs/constants.ts — keep in sync
      now()
    )
    returning id into v_job_id;

    job_id := v_job_id;
    created := true;
    return next;
    return;
  exception when unique_violation then
    -- Idempotent conflict on (job_type, idempotency_key): fetch the
    -- existing job and, if it's dead (exhausted retries), revive it —
    -- same semantics enqueue.ts previously implemented client-side across
    -- three separate round trips; now one atomic server-side path.
    select bj.id, bj.status into v_job_id, v_status
    from public.background_jobs bj
    where bj.job_type = 'invoice_extract' and bj.idempotency_key = p_scan_id::text;

    if v_job_id is null then
      raise exception 'idempotent enqueue conflict but no existing job found for scan %', p_scan_id;
    end if;

    if v_status = 'dead' then
      update public.background_jobs
      set status = 'queued', attempt_count = 0, error_code = null,
          error_message = null, claimed_by = null, claimed_at = null,
          run_after = now()
      where id = v_job_id and status = 'dead';
    end if;

    job_id := v_job_id;
    created := false;
    return next;
    return;
  end;
end;
$$;

comment on function public.enqueue_invoice_extract_job(uuid, uuid) is
  'C20 (db audit 2026-08-23): the only sanctioned way for an authenticated '
  'session to create/revive an invoice_extract background_jobs row. '
  'SECURITY DEFINER because authenticated has no table-level INSERT/UPDATE '
  'on background_jobs at all — verifies staff-or-above membership on '
  'p_restaurant_id and that p_scan_id actually belongs to it, then pins '
  'idempotency_key = p_scan_id, created_by = auth.uid(), status = '
  '''queued'', run_after = now(), and max_attempts to the constant default '
  '— none of those are caller-controlled inputs.';

revoke all on function public.enqueue_invoice_extract_job(uuid, uuid) from public;
grant execute on function public.enqueue_invoice_extract_job(uuid, uuid) to authenticated;

-- ── 3. Per-tenant fairness on the claim function ────────────────────────
create or replace function public.claim_invoice_extract_job(p_worker_id text)
returns setof public.background_jobs
language sql
as $$
  with in_flight as (
    select restaurant_id, count(*) as n
    from public.background_jobs
    where job_type = 'invoice_extract' and status = 'processing'
    group by restaurant_id
  ),
  claimable as (
    select b.id
    from public.background_jobs b
    left join in_flight f on f.restaurant_id = b.restaurant_id
    where b.job_type = 'invoice_extract'
      and b.status = 'queued'
      and b.run_after <= now()
      -- C20 fairness cap: no more than 3 invoice_extract jobs from the
      -- same restaurant may be 'processing' at once, so one tenant's
      -- staff member cannot push enough queued jobs to occupy every
      -- worker slot and starve every other tenant's queue. A starting
      -- value, not a tuned one — there is no production traffic yet.
      and coalesce(f.n, 0) < 3
    order by b.run_after
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
  'FOR UPDATE SKIP LOCKED, excluding any restaurant that already has 3 '
  'jobs in ''processing'' (C20 db audit 2026-08-23 per-tenant fairness '
  'cap). Concurrent worker instances never claim the same row. Returns '
  'zero or one row.';

revoke all on function public.claim_invoice_extract_job(text) from public;
grant execute on function public.claim_invoice_extract_job(text) to service_role;

-- === 0084_rls_initplan_wrap.sql ===
-- 0084_rls_initplan_wrap.sql
--
-- C28 (db audit 2026-08-23) — RLS policies calling non-inlineable
-- SECURITY DEFINER membership helpers (`is_member`, `is_member_with_role`,
-- 0001_auth_boundary.sql) do it once PER ROW a scan examines, even when
-- every row shares the same restaurant_id the index condition already
-- matched on. SECURITY DEFINER functions are never planner-inlined
-- (inlining would silently drop the privilege-elevation semantics), so
-- there is no way around the per-call cost except changing how often the
-- planner calls it.
--
-- Verified (.../scratchpad/db-audit/verify/V1-tenancy.md, C28), hard
-- numbers: at 22,216 rows, a tenant-scoped `count(*)` on wines made
-- 22,217 is_member() calls (pg_stat_user_functions delta) and ran 122ms
-- with 44,485 buffer hits, versus 4.8ms / 53 buffer hits with RLS
-- bypassed — ~25x slower, ~840x the buffer hits, purely from the per-row
-- function-call overhead. Confirmed systemic by grep: 19 migration files
-- use the raw `is_member(restaurant_id)` / `is_member_with_role(
-- restaurant_id, ...)` pattern directly inside a USING/WITH CHECK clause,
-- and zero instances anywhere use the standard mitigation.
--
-- *** This fix lane's own fix sketch got the mitigation wrong; corrected
-- here. *** The sketch's first suggestion — wrap the call as
-- `(select public.is_member(restaurant_id))` — was tried first in this
-- migration's development and MEASURED TO NOT WORK: `restaurant_id` is a
-- column of the row being filtered, so `(select is_member(restaurant_id))`
-- is a CORRELATED subquery (its argument varies per row), which Postgres
-- cannot hoist into a once-per-statement InitPlan — it stays a SubPlan
-- re-executed once per row, identical in cost to the unwrapped call, and
-- measured slightly WORSE here (733ms / 40,435 buffers vs. the unfixed
-- baseline's 122ms / 44,485 buffers) from the added subquery overhead.
-- `(select auth.uid())`-style wraps work in Supabase's own performance
-- guidance because `auth.uid()` takes no row-dependent argument at all —
-- that shape does not generalize to a function whose argument is a
-- column of the row it's filtering.
--
-- The fix that actually works — and the one the fix sketch also named as
-- the "better" alternative — restructures the predicate so the ONLY
-- membership lookup has NO row-dependent input: two new helper functions,
-- `member_restaurant_ids()` and `member_restaurant_ids_with_role(role)`,
-- return the CALLER's own set of qualifying restaurant ids (keyed only on
-- auth.uid() and, for the role variant, a literal role argument — neither
-- varies per row). Policies then read `restaurant_id in (select
-- public.member_restaurant_ids())` — an UNCORRELATED subquery the planner
-- hashes/materializes ONCE per statement, then probes per row via a plain
-- hash lookup instead of a function call. Measured after rewriting wines'
-- four policies to this shape (identical 22-ish-thousand-row scale as
-- above): 1 call to member_restaurant_ids() total (not 20,004+), 3.5-4ms
-- execution time, ~185 buffer hits — matching the RLS-bypassed baseline,
-- not merely improving on the broken-RLS baseline.
--
-- member_restaurant_ids()/_with_role() are SECURITY DEFINER (same
-- recursion-avoidance rationale as is_member/is_member_with_role — a
-- policy on `memberships` itself calling a function that reads
-- `memberships` would recurse under RLS if the function weren't DEFINER)
-- and STABLE. is_member/is_member_with_role themselves are UNCHANGED —
-- still used verbatim inside plpgsql function bodies elsewhere in this
-- schema (find_or_create_wine, set_wine_availability, record_pour, etc.),
-- where the once-per-invocation cost was never the problem C28 measured.
--
-- Semantic equivalence, not just speed, verified for every predicate
-- shape used below: for any given user and restaurant, "restaurant_id IN
-- (select member_restaurant_ids())" is true iff "is_member(restaurant_id)"
-- is true (both reduce to "a memberships row exists for this user and
-- this restaurant_id") — verified directly in this fix lane, side by
-- side under a real authenticated session, for is_member and all three
-- is_member_with_role role arguments ('staff'/'manager'/'owner'), for
-- both an owner (qualifies for all three) and a staff-only member
-- (qualifies for 'staff' only) — all six checks matched old vs. new
-- exactly. RLS baseline (tenant B still sees only its own rows) was
-- re-confirmed after applying this migration.
--
-- Done via `ALTER POLICY ... USING (...) WITH CHECK (...)`, not DROP +
-- CREATE: it changes only the qual/check expression of an existing
-- policy in place, so a policy's name, command, and role list all stay
-- exactly as they were in whichever migration originally created it.
-- Omitting USING or WITH CHECK from a given ALTER POLICY statement below
-- leaves that clause untouched (Postgres semantics) — every statement
-- here supplies exactly the clause(s) the source policy actually has.
--
-- Deliberately NOT touched: the EXISTS-subquery policies that call
-- is_member() on a JOINED table's aliased column (e.g. wine_list_sections
-- / wine_list_items' `public.is_member(wl.restaurant_id)`, C05's own new
-- policies) — those weren't part of the specific 19-file/22,217-call
-- pattern the verifier measured (a correlated per-row argument coming
-- from a join, not the same value repeated across every row of an
-- index-matched scan on the policy's own table), so rewriting them is a
-- separate, unverified change out of this cluster's scope. Also not
-- touched: the `restaurants` table's own two policies (`is_member(id)` /
-- `is_member_with_role(id, 'manager')`) — those key off the table's own
-- primary key column, not `restaurant_id`, and were likewise not part of
-- the measured 19-file pattern.
--
-- DOWN: re-runs the same ALTER POLICY statements with the raw (unwrapped)
-- is_member/is_member_with_role expressions, and drops the two new helper
-- functions. Restores the pre-fix per-row-call plan shape exactly. See
-- down/0084_rls_initplan_wrap.down.sql.

-- ── Helper functions: the caller's own qualifying restaurant id sets ───
create or replace function public.member_restaurant_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select restaurant_id from public.memberships where user_id = auth.uid();
$$;

comment on function public.member_restaurant_ids() is
  'C28 (db audit 2026-08-23): returns every restaurant_id the calling '
  'user is a member of. Takes no row-dependent argument (unlike '
  'is_member(restaurant_id)), so a policy written as '
  '`restaurant_id in (select public.member_restaurant_ids())` lets the '
  'planner evaluate this ONCE per statement (an uncorrelated subquery) '
  'instead of once per row. SECURITY DEFINER for the same reason as '
  'is_member: avoids RLS recursion when used in a policy on memberships '
  'itself.';

create or replace function public.member_restaurant_ids_with_role(required public.membership_role)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select restaurant_id from public.memberships
  where user_id = auth.uid()
    and (
      role = required
      or (required = 'manager' and role = 'owner')
      or (required = 'staff' and role in ('owner', 'manager'))
    );
$$;

comment on function public.member_restaurant_ids_with_role(public.membership_role) is
  'C28 (db audit 2026-08-23): role-hierarchy counterpart to '
  'member_restaurant_ids() — returns every restaurant_id where the '
  'calling user has AT LEAST the given role (same hierarchy as '
  'is_member_with_role: owner satisfies manager and staff, manager '
  'satisfies staff). `required` is a literal per call site, not a row '
  'value, so this is equally safe to use as an uncorrelated `restaurant_id '
  'in (select ...)` subquery.';

revoke all on function public.member_restaurant_ids() from public;
grant execute on function public.member_restaurant_ids() to authenticated;
revoke all on function public.member_restaurant_ids_with_role(public.membership_role) from public;
grant execute on function public.member_restaurant_ids_with_role(public.membership_role) to authenticated;

-- ── 0001_auth_boundary.sql: memberships ─────────────────────────────────
alter policy "users can read memberships in their restaurants"
  on public.memberships
  using (user_id = auth.uid() or restaurant_id in (select public.member_restaurant_ids()));

alter policy "owners can manage memberships in their restaurant"
  on public.memberships
  using      (restaurant_id in (select public.member_restaurant_ids_with_role('owner')))
  with check (restaurant_id in (select public.member_restaurant_ids_with_role('owner')));

-- ── 0002_phase2_schema.sql: wines ────────────────────────────────────────
alter policy "members can read their wines"
  on public.wines
  using (restaurant_id in (select public.member_restaurant_ids()));

alter policy "members can insert wines"
  on public.wines
  with check (restaurant_id in (select public.member_restaurant_ids()));

alter policy "members can update their wines"
  on public.wines
  using      (restaurant_id in (select public.member_restaurant_ids()))
  with check (restaurant_id in (select public.member_restaurant_ids()));

alter policy "members can delete their wines"
  on public.wines
  using (restaurant_id in (select public.member_restaurant_ids()));

-- ── 0002_phase2_schema.sql: invoice_scans ────────────────────────────────
alter policy "members can read their scans"
  on public.invoice_scans
  using (restaurant_id in (select public.member_restaurant_ids()));

alter policy "members can insert scans"
  on public.invoice_scans
  with check (restaurant_id in (select public.member_restaurant_ids()));

-- ── 0002_phase2_schema.sql: inventory_items ──────────────────────────────
alter policy "members can read their inventory"
  on public.inventory_items
  using (restaurant_id in (select public.member_restaurant_ids()));

alter policy "members can insert inventory"
  on public.inventory_items
  with check (restaurant_id in (select public.member_restaurant_ids()));

alter policy "members can update their inventory"
  on public.inventory_items
  using      (restaurant_id in (select public.member_restaurant_ids()))
  with check (restaurant_id in (select public.member_restaurant_ids()));

alter policy "members can delete their inventory"
  on public.inventory_items
  using (restaurant_id in (select public.member_restaurant_ids()));

-- ── 0002_phase2_schema.sql: wine_lists ────────────────────────────────────
alter policy "members can read their wine lists"
  on public.wine_lists
  using (restaurant_id in (select public.member_restaurant_ids()));

alter policy "members can insert wine lists"
  on public.wine_lists
  with check (restaurant_id in (select public.member_restaurant_ids()));

alter policy "members can update their wine lists"
  on public.wine_lists
  using      (restaurant_id in (select public.member_restaurant_ids()))
  with check (restaurant_id in (select public.member_restaurant_ids()));

alter policy "members can delete their wine lists"
  on public.wine_lists
  using (restaurant_id in (select public.member_restaurant_ids()));

-- ── 0004_team_invitations.sql: invitations ──────────────────────────────
alter policy "owners can manage invitations"
  on public.invitations
  using      (restaurant_id in (select public.member_restaurant_ids_with_role('owner')))
  with check (restaurant_id in (select public.member_restaurant_ids_with_role('owner')));

alter policy "managers can read invitations"
  on public.invitations
  using (restaurant_id in (select public.member_restaurant_ids_with_role('manager')));

-- ── 0005_cellar_config.sql: cellar_config ───────────────────────────────
alter policy "members can read cellar config"
  on public.cellar_config
  using (restaurant_id in (select public.member_restaurant_ids()));

alter policy "managers can manage cellar config"
  on public.cellar_config
  using      (restaurant_id in (select public.member_restaurant_ids_with_role('manager')))
  with check (restaurant_id in (select public.member_restaurant_ids_with_role('manager')));

-- ── 0011_scan_idempotency.sql: scan_idempotency ─────────────────────────
alter policy "members manage own idempotency keys"
  on public.scan_idempotency
  using      (restaurant_id in (select public.member_restaurant_ids()))
  with check (restaurant_id in (select public.member_restaurant_ids()));

-- ── 0015_wine_availability.sql: availability_events ─────────────────────
alter policy "members can read availability events"
  on public.availability_events
  using (restaurant_id in (select public.member_restaurant_ids()));

-- ── 0016_pour_tracking.sql: open_bottles, pour_events ───────────────────
alter policy "members can read open_bottles"
  on public.open_bottles
  using (restaurant_id in (select public.member_restaurant_ids()));

alter policy "members can read pour_events"
  on public.pour_events
  using (restaurant_id in (select public.member_restaurant_ids()));

-- ── 0052_background_jobs.sql: background_jobs ───────────────────────────
-- (the pre-fix INSERT policy this table also had was dropped by C20's
-- own fix, 0083 — nothing left to wrap there.)
alter policy "members can read background jobs"
  on public.background_jobs
  using (restaurant_id in (select public.member_restaurant_ids()));

-- ── 0053_reason_codes.sql: reason_codes ─────────────────────────────────
alter policy "members can read reason_codes"
  on public.reason_codes
  using (restaurant_id in (select public.member_restaurant_ids()));

alter policy "managers can insert reason_codes"
  on public.reason_codes
  with check (restaurant_id in (select public.member_restaurant_ids_with_role('manager')));

alter policy "managers can update reason_codes"
  on public.reason_codes
  using      (restaurant_id in (select public.member_restaurant_ids_with_role('manager')))
  with check (restaurant_id in (select public.member_restaurant_ids_with_role('manager')));

-- ── 0054_wine_lineages.sql: wine_lineages ────────────────────────────────
alter policy "members can read wine_lineages"
  on public.wine_lineages
  using (restaurant_id in (select public.member_restaurant_ids()));

-- ── 0057_bins.sql: bins ──────────────────────────────────────────────────
alter policy "members can read bins"
  on public.bins
  using (restaurant_id in (select public.member_restaurant_ids()));

alter policy "managers can insert bins"
  on public.bins
  with check (restaurant_id in (select public.member_restaurant_ids_with_role('manager')));

alter policy "managers can update bins"
  on public.bins
  using      (restaurant_id in (select public.member_restaurant_ids_with_role('manager')))
  with check (restaurant_id in (select public.member_restaurant_ids_with_role('manager')));

-- ── 0058_cellar_health.sql: cellar_health ────────────────────────────────
alter policy "members can read cellar_health"
  on public.cellar_health
  using (restaurant_id in (select public.member_restaurant_ids()));

-- ── 0059_reconcile_queue.sql: reconcile_batches, reconcile_actions ──────
alter policy "members can read reconcile_batches"
  on public.reconcile_batches
  using (restaurant_id in (select public.member_restaurant_ids()));

alter policy "members can read reconcile_actions"
  on public.reconcile_actions
  using (restaurant_id in (select public.member_restaurant_ids()));

alter policy "managers can insert reconcile_batches"
  on public.reconcile_batches
  with check (restaurant_id in (select public.member_restaurant_ids_with_role('manager')));

alter policy "managers can update reconcile_batches"
  on public.reconcile_batches
  using      (restaurant_id in (select public.member_restaurant_ids_with_role('manager')))
  with check (restaurant_id in (select public.member_restaurant_ids_with_role('manager')));

alter policy "managers can insert reconcile_actions"
  on public.reconcile_actions
  with check (restaurant_id in (select public.member_restaurant_ids_with_role('manager')));

-- ── 0060_partial_bottles.sql: bottle_closeouts ──────────────────────────
alter policy "members can read bottle_closeouts"
  on public.bottle_closeouts
  using (restaurant_id in (select public.member_restaurant_ids()));

alter policy "members can insert bottle_closeouts"
  on public.bottle_closeouts
  with check (restaurant_id in (select public.member_restaurant_ids()));

-- ── 0063_stock_adjustments.sql: stock_adjustments ───────────────────────
alter policy "members can read stock_adjustments"
  on public.stock_adjustments
  using (restaurant_id in (select public.member_restaurant_ids()));

alter policy "members insert own stock_adjustments"
  on public.stock_adjustments
  with check (
    restaurant_id in (select public.member_restaurant_ids())
    and acting_user_id = auth.uid()
  );

-- ── 0064_brand_kits.sql: brand_kits ──────────────────────────────────────
alter policy "members can read brand_kits"
  on public.brand_kits
  using (restaurant_id in (select public.member_restaurant_ids()));

alter policy "managers can insert brand_kits"
  on public.brand_kits
  with check (restaurant_id in (select public.member_restaurant_ids_with_role('manager')));

alter policy "managers can update brand_kits"
  on public.brand_kits
  using      (restaurant_id in (select public.member_restaurant_ids_with_role('manager')))
  with check (restaurant_id in (select public.member_restaurant_ids_with_role('manager')));

-- ── 0065_pricing_recommendations.sql: pricing_recommendations ──────────
alter policy "members can read pricing_recommendations"
  on public.pricing_recommendations
  using (restaurant_id in (select public.member_restaurant_ids()));

-- ── 0066_invoice_scans_update_policy.sql: invoice_scans ─────────────────
alter policy "members can update their scans"
  on public.invoice_scans
  using      (restaurant_id in (select public.member_restaurant_ids()))
  with check (restaurant_id in (select public.member_restaurant_ids()));

-- ── 0076_csv_import_batches.sql: import_batches, import_batch_rows ─────
alter policy "members can read import batches"
  on public.import_batches
  using (restaurant_id in (select public.member_restaurant_ids()));

alter policy "members can create own import batches"
  on public.import_batches
  with check (
    restaurant_id in (select public.member_restaurant_ids_with_role('staff'))
    and created_by = auth.uid()
  );

alter policy "members can update own import batches"
  on public.import_batches
  using      (restaurant_id in (select public.member_restaurant_ids_with_role('staff')))
  with check (restaurant_id in (select public.member_restaurant_ids_with_role('staff')));

alter policy "members can read import batch rows"
  on public.import_batch_rows
  using (restaurant_id in (select public.member_restaurant_ids()));

alter policy "members can create import batch rows"
  on public.import_batch_rows
  with check (restaurant_id in (select public.member_restaurant_ids_with_role('staff')));

alter policy "members can update import batch rows"
  on public.import_batch_rows
  using      (restaurant_id in (select public.member_restaurant_ids_with_role('staff')))
  with check (restaurant_id in (select public.member_restaurant_ids_with_role('staff')));
