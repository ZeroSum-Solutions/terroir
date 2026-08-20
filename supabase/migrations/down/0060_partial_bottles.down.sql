-- down for 0060_partial_bottles.sql
drop table if exists public.bottle_closeouts;
alter table public.open_bottles
  drop column if exists preservation_method;
