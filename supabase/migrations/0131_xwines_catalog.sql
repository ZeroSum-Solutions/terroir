-- X-Wines reference corpus.
--
-- The cellar has never had a column for how a wine TASTES. `wines` carries
-- identity, stock, pricing, drink window and serving temperature, but nothing
-- for body, acidity, alcohol, grape composition or what to eat with it — the
-- facts a guest actually asks a sommelier about. This migration lands the
-- reference corpus that supplies them.
--
-- Source: X-Wines (de Azambuja et al.), the Full 100K distribution, licensed
-- CC0-1.0. Two grains arrive together because they answer two different
-- questions:
--
--   xwines_catalog        one row per wine (100,646) — the attributes, plus the
--                         wine's rating average and count.
--   xwines_vintage_ratings one row per (wine, vintage) (1,008,593) — the grain
--                         a "compare vintages" surface needs, since a 2015 and
--                         a 2019 of the same wine are rated separately.
--
-- Both rating columns are AGGREGATES computed from the corpus's 21,013,536
-- individual ratings, on the corpus's own 1.0–5.0 scale. The raw ratings are
-- deliberately NOT imported: 21M rows would dwarf every other table here and
-- nothing in the product reads an individual stranger's rating.
--
-- Shaped after lwin_catalog (0003_wine_intelligence.sql:20-45): a global,
-- read-only reference table, authenticated-select RLS, trigram indexes on the
-- two columns matching joins against. It is NOT restaurant-scoped and holds no
-- tenant data, so there is no is_member() predicate to write.
-------------------------------------------------------------------------------

create table public.xwines_catalog (
  wine_id       integer     primary key,
  name          text        not null,
  type          text,
  elaborate     text,
  grapes        text[]      not null default '{}',
  harmonize     text[]      not null default '{}',
  abv           numeric(4,1),
  body          text,
  acidity       text,
  country_code  text,
  country       text,
  region_id     integer,
  region_name   text,
  winery_id     integer,
  winery_name   text,
  website       text,
  vintages      integer[]   not null default '{}',
  -- NV bottlings appear in the corpus as the literal 'N.V.' among the vintage
  -- list; `vintages` holds only the numeric years, and this flag carries the
  -- rest so a non-vintage wine is not silently rendered as vintage-less.
  has_non_vintage boolean   not null default false,
  rating_avg    numeric(4,3),
  rating_count  integer     not null default 0,
  constraint xwines_catalog_rating_avg_range
    check (rating_avg is null or (rating_avg >= 1 and rating_avg <= 5)),
  constraint xwines_catalog_rating_count_non_negative
    check (rating_count >= 0)
);

create index xwines_catalog_winery_trgm_idx
  on public.xwines_catalog using gin (winery_name gin_trgm_ops);

create index xwines_catalog_name_trgm_idx
  on public.xwines_catalog using gin (name gin_trgm_ops);

create index xwines_catalog_type_idx     on public.xwines_catalog (type);
create index xwines_catalog_country_idx  on public.xwines_catalog (country);
create index xwines_catalog_grapes_idx    on public.xwines_catalog using gin (grapes);
create index xwines_catalog_harmonize_idx on public.xwines_catalog using gin (harmonize);

comment on table public.xwines_catalog is
  'X-Wines Full 100K reference corpus (CC0-1.0). Global, read-only. '
  'rating_avg/rating_count are aggregated from the distribution''s 21M '
  'ratings on its native 1.0-5.0 scale.';

create table public.xwines_vintage_ratings (
  wine_id      integer not null references public.xwines_catalog (wine_id) on delete cascade,
  vintage      integer not null,
  rating_avg   numeric(4,3) not null,
  rating_count integer not null,
  primary key (wine_id, vintage),
  constraint xwines_vintage_ratings_avg_range
    check (rating_avg >= 1 and rating_avg <= 5),
  constraint xwines_vintage_ratings_count_positive
    check (rating_count > 0)
);

comment on table public.xwines_vintage_ratings is
  'Per-(wine, vintage) rating aggregate from the X-Wines 21M rating corpus. '
  'A row exists only where at least one rating does; absence means "no '
  'ratings yet", which a reader must render as such rather than as zero.';

-------------------------------------------------------------------------------
-- RLS — global reference data, readable by any authenticated user.
-- No write policy: these tables are populated by scripts/seed-xwines.ts running
-- under the service role, which bypasses RLS. Leaving writes unpolicied means a
-- compromised end-user session cannot rewrite the corpus every restaurant reads.
-------------------------------------------------------------------------------
alter table public.xwines_catalog        enable row level security;
alter table public.xwines_vintage_ratings enable row level security;

create policy "anyone can read xwines_catalog"
  on public.xwines_catalog for select to authenticated
  using (true);

create policy "anyone can read xwines_vintage_ratings"
  on public.xwines_vintage_ratings for select to authenticated
  using (true);

-- Grants, explicitly, rather than relying on the ambient `alter default
-- privileges` Supabase applies to tables created in a CLI-run migration. A
-- policy is checked only AFTER the table-level privilege is granted, so a table
-- with a permissive policy and no grant fails with "permission denied for
-- table" — which reads like a policy bug and is not one. Making the grant part
-- of the migration also means the table behaves the same however it was
-- applied.
grant select on public.xwines_catalog         to authenticated;
grant select on public.xwines_vintage_ratings to authenticated;

-- The seed script (scripts/seed-xwines.ts) writes as service_role.
grant select, insert, update, delete on public.xwines_catalog         to service_role;
grant select, insert, update, delete on public.xwines_vintage_ratings to service_role;
