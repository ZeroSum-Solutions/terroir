-- BND-171: add hidden column to wine_list_items to exclude from public views
alter table public.wine_list_items
  add column if not exists hidden boolean not null default false;
