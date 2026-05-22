-- BND-169: add name_override column to wine_list_items
alter table public.wine_list_items
  add column if not exists name_override text;
