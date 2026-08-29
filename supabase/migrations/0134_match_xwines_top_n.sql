-- match_xwines returned one row; the caller's bar is stricter than the
-- function's.
--
-- 0132 ends `order by score desc, xc.wine_id asc limit 1`, and the RPC's own
-- admission bar is loose by design: the cuvée need only clear
-- `p_threshold * 0.7` (0.21 at the default threshold). The acceptance rule that
-- actually decides what a reader is shown lives in
-- src/lib/wine-intelligence/xwines-profile.ts and is far stricter — a blended
-- floor, a producer floor, and now a name floor. So the single row this
-- function returned was routinely rejected client-side while a second,
-- ACCEPTABLE candidate sat one position below it, never sent.
--
-- Measured instance, on the local corpus: "E. Guigal" / "Cotes-du-Rhone"
-- returns "Côtes-du-Rhône Rosé" first (score 0.744) with "Côtes-du-Rhône
-- Rouge" (0.738) and "Côtes-du-Rhône Blanc" (0.733) behind it. Whichever of
-- those a stricter client rule prefers, under `limit 1` it never saw them.
--
-- `p_limit` defaults to 5: enough for a client floor to walk past a few
-- near-ties, small enough that the added work is bounded (the ordering is
-- unchanged, so rows 2..N are the ones the sort already produced).
--
-- Everything else is 0132 verbatim — the same predicates, the same 0.6/0.4
-- weighting, the same transaction-local pg_trgm.similarity_threshold, the same
-- deterministic `score desc, wine_id asc` tie-break (0127's fix), the same
-- `security definer set search_path = public`, the same revoke/grant pair.
-- Only the row count changes.
--
-- The three-argument function is DROPPED rather than left beside the new one.
-- PostgREST resolves an RPC by the named arguments in the request body, and
-- two overloads that both accept {p_producer, p_name, p_threshold} are
-- ambiguous — the call would fail at runtime, not at deploy. One arity only.
--
-- DOWN: drops the four-argument function and restores 0132's three-argument
-- body verbatim. See down/0134_match_xwines_top_n.down.sql.

drop function if exists public.match_xwines(text, text, float);

create or replace function public.match_xwines(
  p_producer  text,
  p_name      text,
  p_threshold float default 0.3,
  p_limit     integer default 5
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
  limit p_limit;
$$;

revoke all on function public.match_xwines(text, text, float, integer) from public;
grant execute on function public.match_xwines(text, text, float, integer) to authenticated;
