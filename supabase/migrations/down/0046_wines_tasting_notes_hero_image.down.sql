-- 0046_wines_tasting_notes_hero_image.down.sql

alter table public.wines
  drop column if exists tasting_notes,
  drop column if exists hero_image_url;
