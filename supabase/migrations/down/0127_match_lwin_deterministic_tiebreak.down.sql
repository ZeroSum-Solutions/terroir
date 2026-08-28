-- Reverse of 0127_match_lwin_deterministic_tiebreak.sql
--
-- Restores 0078's EXACT body, including its bare `order by score desc`. Applying
-- this down reinstates the nondeterministic tie: two catalogue rows with equal
-- score again have no defined winner, so preview and confirm can select
-- different LWIN ids for the same import row.

create or replace function public.match_lwin(
  p_producer  text,
  p_name      text,
  p_threshold float default 0.3
)
returns table (
  lwin_id      text,
  display_name text,
  producer     text,
  varietal     text,
  region       text,
  country      text,
  colour       text,
  score        float
)
language sql security definer set search_path = public
as $$
  select set_config('pg_trgm.similarity_threshold', p_threshold::text, true);
  select lc.lwin_id, lc.display_name, lc.producer, lc.varietal,
         lc.region, lc.country, lc.colour,
         (similarity(lower(p_producer), lower(lc.producer)) * 0.6 +
          similarity(lower(p_name), lower(lc.display_name)) * 0.4) as score
  from public.lwin_catalog lc
  where lower(lc.producer) % lower(p_producer)
    and similarity(lower(p_producer), lower(lc.producer)) >= p_threshold
    and similarity(lower(p_name), lower(lc.display_name)) >= p_threshold * 0.7
  order by score desc
  limit 1;
$$;

revoke all on function public.match_lwin(text, text, float) from public;
grant execute on function public.match_lwin(text, text, float) to authenticated;
