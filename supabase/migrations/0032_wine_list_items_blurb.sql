-- BND-170: add blurb column to wine_list_items for custom per-item text
alter table public.wine_list_items
  add column if not exists blurb text;
