-- Attach the X-Wines corpus to the identity spine.
--
-- WHERE the link lives is the whole decision here. Body, acidity, ABV, grape
-- composition and food pairing are facts about a producer's cuvée — they do not
-- vary by which restaurant happens to stock the bottle. So the link hangs off
-- `canonical_wines`, the shared catalog layer every import contributes to
-- (0097_canonical_wines.sql:173-181), and tenant rows reach it by the
-- `wines.canonical_wine_id` they already carry (0098_wine_variants.sql:93-94).
--
-- Putting these columns on `wines` instead would copy the same corpus facts
-- once per restaurant per bottling, and let two restaurants stocking the same
-- wine disagree about its acidity. `wine_variants` would be wrong for the
-- opposite reason: it is vintage- and size-grained, and a cuvée's body does not
-- change between a 750ml and a magnum.
--
-- Vintage-varying data is NOT stored here. Per-vintage ratings live at their own
-- grain in xwines_vintage_ratings (0131) and are read through
-- xwines_catalog.wine_id.
-------------------------------------------------------------------------------

alter table public.canonical_wines
  add column xwines_wine_id     integer references public.xwines_catalog (wine_id) on delete set null,
  add column xwines_match_score real;

-- Partial: only a minority of canonical wines will ever match the corpus (the
-- corpus is consumer-review breadth, the cellar is trade), so indexing the
-- nulls would be most of the index.
create index canonical_wines_xwines_wine_id_idx
  on public.canonical_wines (xwines_wine_id)
  where xwines_wine_id is not null;

comment on column public.canonical_wines.xwines_match_score is
  'Trigram score from match_xwines that produced xwines_wine_id, retained so a '
  'weak match can be re-examined or superseded without re-running the matcher. '
  'Null when the link was set by any means other than the matcher.';

-------------------------------------------------------------------------------
-- match_xwines — producer-weighted trigram match against the corpus.
--
-- Deliberately mirrors match_lwin's shape and weighting (0127, itself carrying
-- 0078's semantics): producer similarity is worth 0.6 and cuvée 0.4, the
-- producer must clear the threshold outright, and the cuvée need only clear
-- 70% of it — a producer is the stronger signal, and cuvée names vary far more
-- in punctuation and qualifiers.
--
-- The `order by score desc, wine_id asc` tie-break is 0127's fix, applied here
-- for the same reason: without a total order two rows tying on score have no
-- defined winner, and a match run twice (preview, then confirm) can resolve
-- differently and persist a wine the operator never approved. `wine_id` is the
-- primary key, so it is non-null and unique; ascending is arbitrary but stable.
--
-- UNLIKE match_lwin, this returns the two component similarities alongside the
-- blend, because the blend alone cannot express the failure mode that matters
-- here. Measured against this repo's own seed cellar: "Bodegas Muga" / "Reserva"
-- blends to 0.667 against "Borsao Bodegas" / "Reserva" — a wrong producer
-- carried over the line by an exactly-matching cuvée name (0.445*0.6 +
-- 1.0*0.4). A caller enriching a wine with someone else's acidity and food
-- pairings needs to floor the PRODUCER independently, so it is given the number
-- to floor. See xwines-profile.ts for the acceptance rule and the measurements
-- behind it.
-------------------------------------------------------------------------------
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
