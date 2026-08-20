-- down for 0064_brand_kits.sql
alter table public.wine_lists drop column if exists theme;
drop table if exists public.brand_kits;
