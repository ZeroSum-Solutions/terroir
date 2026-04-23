-- 0019_wine_published_list_slugs.sql — ARCH-019
-- Stable SQL RPC that returns the slugs of every published wine list
-- that references a given wine. Used by PATCH /api/wines/[id]/availability
-- to revalidate the public /list/[slug] pages after a 86 / restore.
--
-- Replaces an in-line PostgREST nested !inner filter, which was
-- PostgREST-version-fragile: a syntax change in the filter operator
-- would have broken revalidation silently.

create or replace function public.wine_published_list_slugs(
  p_wine_id uuid,
  p_restaurant_id uuid
) returns table (slug text)
language sql
stable
security definer
set search_path = public
as $$
  select distinct wl.slug
  from public.wine_lists wl
  join public.wine_list_sections s on s.wine_list_id = wl.id
  join public.wine_list_items i on i.section_id = s.id
  where i.wine_id = p_wine_id
    and wl.restaurant_id = p_restaurant_id
    and wl.is_published = true
    and wl.slug is not null
    and public.is_member(p_restaurant_id);
$$;

grant execute on function public.wine_published_list_slugs(uuid, uuid) to authenticated;
