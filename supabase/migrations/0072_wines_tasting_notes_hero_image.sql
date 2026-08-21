-- 0072_wines_tasting_notes_hero_image.sql
-- BND-055 + BND-056 + BND-057: add tasting_notes and hero_image_url
-- to the wines table.

alter table public.wines
  add column if not exists tasting_notes text,
  add column if not exists hero_image_url text;
