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
