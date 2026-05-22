-- Add archived column to wine_lists for feature #158
alter table public.wine_lists
  add column archived boolean not null default false;
