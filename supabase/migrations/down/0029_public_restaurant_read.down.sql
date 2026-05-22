-- Reverse of 0029_public_restaurant_read.sql

drop policy if exists "public can read restaurants with published lists" on public.restaurants;
