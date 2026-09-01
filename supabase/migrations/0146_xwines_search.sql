-- 0146_xwines_search.sql
-- P1 slice 1 (program plan §7): free-text search over the X-Wines corpus for
-- the unified palette's catalogue pass.
--
-- The corpus has matchers but no search: match_xwines (0132/0134) answers
-- "score THIS (producer, cuvée) against the corpus" and needs both halves
-- split out, which a person typing into one box does not provide. This is the
-- lwin_search (0007) shape applied to xwines_catalog: one query string,
-- trigram-matched against winery and wine name, best similarity wins.
--
-- Differences from lwin_search, each deliberate:
--   - Predicates and similarity use lower(...) so the 0133 lower-expression
--     GIN indexes serve them — 0133 exists precisely because match_xwines's
--     raw-column predicates seq-scanned all 100,646 rows.
--   - Deterministic `wine_id asc` tie-break (0127's rule): equal-scoring rows
--     must order identically across calls or a re-rendered result list
--     reshuffles under the reader.
--   - Returns an explicit column list, not setof the table: the palette needs
--     identity + geography + the image columns (whose `kind` a caller MUST
--     read before showing the picture — corpus-image rules, 0138), and a
--     score. rating/grape/pairing columns stay out until a surface needs them.
--
-- security definer like lwin_search/match_xwines: global reference read, RLS
-- has nothing tenant-scoped to enforce here. Granted to authenticated (the
-- route's role) AND service_role — 0145 measured what omitting service_role
-- does to a batch caller.

create or replace function public.xwines_search(p_query text, p_limit int default 20)
returns table (
  wine_id     integer,
  name        text,
  winery_name text,
  region_name text,
  country     text,
  type        text,
  image_url   text,
  image_kind  text,
  score       float
)
language sql stable security definer set search_path = public
as $$
  select xc.wine_id, xc.name, xc.winery_name, xc.region_name, xc.country, xc.type,
         xc.image_url, xc.image_kind,
         greatest(
           similarity(lower(xc.winery_name), lower(p_query)),
           similarity(lower(xc.name), lower(p_query))
         )::float as score
  from public.xwines_catalog xc
  where lower(xc.winery_name) % lower(p_query)
     or lower(xc.name) % lower(p_query)
  order by score desc, xc.wine_id asc
  limit p_limit;
$$;

revoke all on function public.xwines_search(text, int) from public;
grant execute on function public.xwines_search(text, int) to authenticated;
grant execute on function public.xwines_search(text, int) to service_role;
