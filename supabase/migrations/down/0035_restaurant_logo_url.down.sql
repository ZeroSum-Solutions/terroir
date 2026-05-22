-- 0035_restaurant_logo_url.down.sql

alter table public.restaurants drop column if exists logo_url;
