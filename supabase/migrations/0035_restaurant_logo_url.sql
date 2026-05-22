-- 0035_restaurant_logo_url.sql
-- Add logo_url column to restaurants

alter table public.restaurants
  add column logo_url text;
