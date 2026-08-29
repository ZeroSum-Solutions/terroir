-- Reverses 0134: restores 0132's three-argument, single-row match_xwines
-- verbatim and removes the four-argument form.
--
-- Rolling this back re-breaks the defect 0134 fixed — a client whose
-- acceptance floors are stricter than the RPC's prefilter will again see only
-- the top-scoring row. src/lib/wine-intelligence/xwines-profile.ts must be
-- reverted alongside it: it calls the RPC with p_limit and walks the returned
-- list.

drop function if exists public.match_xwines(text, text, float, integer);

create or replace function public.match_xwines(
  p_producer  text,
  p_name      text,
  p_threshold float default 0.3
)
returns table (
  wine_id        integer,
  name           text,
  winery_name    text,
  region_name    text,
  country        text,
  type           text,
  score          float,
  producer_score float,
  name_score     float
)
language sql security definer set search_path = public
as $$
  select set_config('pg_trgm.similarity_threshold', p_threshold::text, true);
  select xc.wine_id, xc.name, xc.winery_name, xc.region_name, xc.country, xc.type,
         (similarity(lower(p_producer), lower(xc.winery_name)) * 0.6 +
          similarity(lower(p_name), lower(xc.name)) * 0.4) as score,
         similarity(lower(p_producer), lower(xc.winery_name))::float as producer_score,
         similarity(lower(p_name), lower(xc.name))::float as name_score
  from public.xwines_catalog xc
  where lower(xc.winery_name) % lower(p_producer)
    and similarity(lower(p_producer), lower(xc.winery_name)) >= p_threshold
    and similarity(lower(p_name), lower(xc.name)) >= p_threshold * 0.7
  order by score desc, xc.wine_id asc
  limit 1;
$$;

revoke all on function public.match_xwines(text, text, float) from public;
grant execute on function public.match_xwines(text, text, float) to authenticated;
