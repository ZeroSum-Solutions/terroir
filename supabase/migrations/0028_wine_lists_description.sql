-- Add description column to wine_lists for feature #153
alter table public.wine_lists
  add column description text;
