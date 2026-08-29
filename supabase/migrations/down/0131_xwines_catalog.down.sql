drop policy if exists "anyone can read xwines_vintage_ratings" on public.xwines_vintage_ratings;
drop policy if exists "anyone can read xwines_catalog"         on public.xwines_catalog;

-- Child first: xwines_vintage_ratings carries the FK.
drop table if exists public.xwines_vintage_ratings;
drop table if exists public.xwines_catalog;
