-- SCAN-06 (decision D3, docs/plans/2026-08-30-field-walk-decisions.md): cellar
-- search finds nothing for a misspelled or accent-dropped query.
--
-- Reported from the field: a search for a Frédéric Savart champagne typed as
-- "Fredric savart" returned an empty list. GET /api/wines/search built ONE
-- substring pattern out of the WHOLE query
-- (`name.ilike.%q%,producer.ilike.%q%`), which fails twice over:
--
--   select count(*) from public.wines
--    where name ilike '%Fredric savart%' or producer ilike '%Fredric savart%';
--   -> 0
--
-- (1) a multi-word query cannot span producer + name, and (2) ILIKE has no
-- typo or diacritic tolerance at all.
--
-- WHOLE-STRING TRIGRAM IS NOT THE FIX, and was measured before this was
-- written: `similarity()` over the concatenated row at pg_trgm's default 0.3
-- returns 0 rows, because a long wine name dilutes the score of a short query.
--
-- PER-TOKEN word_similarity IS the fix. Measured on the local corpus,
-- unaccent-folded:
--
--   query token      vs target                             word_similarity
--   ---------------  -----------------------------------   ---------------
--   'fredric'        'Jacques-Frédéric Mugnier Musigny'         0.545455
--   'savart'         'Savart Haute Couture'                     1.000
--   'bereche'        'Bérêche & Fils Le Cran'                   1.000
--   'vosne romanee'  'Benjamin Leroux Vosne-Romanée'            1.000
--
-- THE 0.5 THRESHOLD IS LOAD-BEARING AND IS THEREFORE SET EXPLICITLY.
-- 'fredric' -> 'Frédéric' is a dropped letter plus two dropped accents — the
-- hardest real case from the field notes — and scores 0.545455. That clears
-- 0.5 and FAILS pg_trgm's DEFAULT word_similarity_threshold of 0.6. Inheriting
-- the default would ship this function with the exact bug it exists to fix, so
-- p_threshold defaults to 0.5 and the caller passes it explicitly as well.
--
-- A row scores as the MAX over the query's tokens, not the similarity of the
-- whole query string: a user misspelling the first name must not exclude a
-- correct producer match. Tokens shorter than three characters are dropped —
-- trigram similarity is meaningless below a full trigram, and the exact
-- substring pass in the route already serves short queries well.
--
-- MATCHES AGAINST producer || ' ' || name, NOT producer ALONE. 1,277 of the
-- 1,527 wines in the local corpus (and the equivalent production batch, see
-- AGENTS.md) came from a CSV import that left `producer` EMPTY with the
-- producer name embedded in `name` ("Benjamin Leroux Vosne-Romanée"). 0137
-- repaired 956 of those; the remaining 321 keep an empty producer BY DESIGN,
-- because their spelling is not in LWIN ("Bérêche & Fils" vs the catalogue's
-- "Bereche et Fils"). Any matcher that assumes a populated producer is blind
-- to the majority of the corpus.
--
-- SECURITY POSTURE: SECURITY INVOKER, deliberately, and NOT the SECURITY
-- DEFINER posture of match_lwin (0127) / match_xwines (0134). Those two read
-- the GLOBAL, non-tenant-scoped reference catalogues; this one reads
-- public.wines, which is tenant data. 0079 established the rule for exactly
-- this shape: as SECURITY INVOKER the driving SELECT is subject to `wines`'
-- own RLS (members-only, keyed on is_member(restaurant_id)) for the ACTUAL
-- calling role, so a caller who passes another tenant's restaurant_id sees an
-- empty result rather than that tenant's cellar. The explicit
-- `restaurant_id = p_restaurant_id` predicate is the second layer, not the
-- only one — it narrows a member with several memberships to the session's
-- own restaurant, which is the only value the route passes (requireMembership
-- resolves it server-side; it is never client-supplied).
--
-- INDEX. There was no trigram index on public.wines at all. `unaccent(text)`
-- is STABLE, not IMMUTABLE, so it cannot appear in an index expression;
-- immutable_unaccent() is the standard pinned-dictionary wrapper that makes
-- the expression indexable, and the same expression is used in the predicate
-- so the planner can actually read the index. Measured, `explain (analyze,
-- buffers)` on the function's own predicate for the token 'fredric':
--
--   before  Seq Scan, 1,509 rows removed by filter, 71 shared hits, 19.2 ms
--   after   Bitmap Index Scan (18 rows) -> Bitmap Heap Scan, 20 hits, 0.20 ms
--
-- ONE index. gin_trgm_ops answers `<%` / `%>` (which is what this predicate
-- uses) but not a bare `word_similarity()` call, and 0133 already measured
-- that shipping an index the planner cannot read is dead weight.
--
-- immutable_unaccent keeps its default PUBLIC execute grant, unlike the RPC:
-- it is a pure text function that touches no data, and every role that INSERTs
-- or UPDATEs a wine must be able to evaluate the index expression.
--
-- This migration is additive and safe against a database the OLD code is still
-- talking to (AGENTS.md non-negotiable #7): the existing ILIKE search path is
-- untouched and keeps working with or without this function.
--
-- PARAMETER CLAMPS (adversarial review finding, applied same-branch). This
-- function is `grant execute ... to authenticated`, and a direct PostgREST
-- RPC call is not limited to what the route above passes. SECURITY INVOKER +
-- `wines` RLS stops a cross-tenant *read*, but does nothing about cost: a
-- caller can still ask their OWN restaurant_id for `p_limit: -1` (Postgres
-- reads a negative LIMIT as "no limit") or `p_threshold: 0` (`<%` then
-- matches essentially every row) and force unbounded trigram work.
--
--   p_threshold clamped to [0.3, 1.0]. 0.3 is pg_trgm's own
--   `similarity_threshold` GUC default — not this migration's number, but
--   the extension's, so a query never runs more permissively than pg_trgm's
--   own baseline for "this is a plausible match" mode. It sits comfortably
--   below the 0.5 this function is always called with (see the comment
--   above and route.ts's FUZZY_WORD_SIMILARITY_THRESHOLD), so no real caller
--   is ever clamped. 1.0 is word_similarity's own ceiling (exact match).
--
--   p_limit clamped to [1, 1000]. 1000 is not an arbitrary round number: it
--   is the exact ceiling route.ts already uses as its widest legitimate
--   candidate set (`const limit = derivedFilter ? 1000 : 20`, for the
--   open/low filters' wide pre-filter pull), so a direct RPC caller can never
--   ask this function to do more work than the route's own heaviest path
--   already does for a member of the same restaurant.
--
-- DOWN: drops the RPC, the index and the wrapper.
-- See down/0144_wines_fuzzy_search.down.sql.

create extension if not exists pg_trgm;
create extension if not exists unaccent;

-- Pinned-dictionary wrapper. `unaccent(text)` resolves its dictionary through
-- search_path and is therefore only STABLE; naming the dictionary explicitly
-- makes the result depend on nothing but the argument, which is what an index
-- expression requires.
create or replace function public.immutable_unaccent(text)
returns text
language sql immutable strict parallel safe
as $$
  select public.unaccent('public.unaccent'::regdictionary, $1)
$$;

comment on function public.immutable_unaccent(text) is
  'IMMUTABLE, pinned-dictionary unaccent() wrapper. Exists so accent-folded text can be indexed (0144).';

create index if not exists wines_search_text_trgm_idx
  on public.wines using gin (
    public.immutable_unaccent(
      lower(coalesce(producer, '') || ' ' || coalesce(name, ''))
    ) gin_trgm_ops
  );

create or replace function public.search_wines_fuzzy(
  p_restaurant_id uuid,
  p_query         text,
  p_threshold     float default 0.5,
  p_limit         integer default 20
)
returns table (
  wine_id uuid,
  score   float
)
language sql security invoker set search_path = public
as $$
  select set_config(
    'pg_trgm.word_similarity_threshold',
    least(greatest(coalesce(p_threshold, 0.5), 0.3), 1.0)::text,
    true
  );
  with tokens as (
    select distinct t.token
    from unnest(
           regexp_split_to_array(
             public.immutable_unaccent(lower(coalesce(p_query, ''))),
             '[^[:alnum:]]+'
           )
         ) as t(token)
    where length(t.token) >= 3
  )
  select w.id,
         max(
           word_similarity(
             t.token,
             public.immutable_unaccent(
               lower(coalesce(w.producer, '') || ' ' || coalesce(w.name, ''))
             )
           )
         )::float
  from public.wines w
  cross join tokens t
  where w.restaurant_id = p_restaurant_id
    and t.token <% public.immutable_unaccent(
          lower(coalesce(w.producer, '') || ' ' || coalesce(w.name, ''))
        )
  group by w.id
  -- Deterministic tie-break, for 0127's reason: at this threshold whole blocks
  -- of rows tie on 1.0, and `order by score desc` alone leaves the winner
  -- undefined between calls. `wines.id` is the primary key, so it is a total
  -- order; ascending is stable and arbitrary, and no meaning attaches to it.
  order by 2 desc, w.id asc
  limit least(greatest(coalesce(p_limit, 20), 1), 1000);
$$;

comment on function public.search_wines_fuzzy(uuid, text, float, integer) is
  'SCAN-06: typo/diacritic-tolerant wine search. Scores a row as the MAX per-token word_similarity over unaccent(lower(producer || name)). SECURITY INVOKER so wines RLS applies (0079).';

revoke all on function public.search_wines_fuzzy(uuid, text, float, integer) from public;
grant execute on function public.search_wines_fuzzy(uuid, text, float, integer) to authenticated;
