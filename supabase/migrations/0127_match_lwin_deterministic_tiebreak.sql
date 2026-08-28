-- Deterministic tie-break for match_lwin.
--
-- 0078 ranked candidates with a bare `order by score desc`. Two catalogue rows
-- tying on score therefore had NO defined winner: Postgres was free to return
-- either, and could return a different one between calls.
--
-- That matters because CSV import matches TWICE — once building the preview the
-- operator reviews, and again inside confirmImportBatch, which deliberately
-- re-runs buildImportPreview from scratch rather than trusting a client-supplied
-- preview. A tie resolving differently between those two phases means the
-- operator approves one wine and a different one is persisted.
--
-- `lwin_id` is `lwin_catalog`'s primary key (0003_wine_intelligence.sql:21), so
-- it is non-null and unique — a total order, and therefore a valid final
-- tie-break. Ascending is chosen only because it is stable and arbitrary; no
-- meaning attaches to a lower LWIN id.
--
-- This fixes match_lwin_bulk and match_lwin_batch transitively: both delegate to
-- match_lwin rather than ranking candidates themselves
-- (0076_csv_import_batches.sql:265 `left join lateral public.match_lwin(...)`,
-- 0079_wine_rpc_invoker_boundary.sql:186 `select * into m from public.match_lwin(...)`).
--
-- What this does NOT subsume, and must not be used to justify deleting:
--   - the ascending flat-index reducer in preview-service.ts, which chooses
--     between SEPARATE producer-query variants, not between tied catalogue rows
--     inside one query;
--   - the LWIN approval veto in batch-service.ts, which also defends against the
--     catalogue itself changing between preview and confirm (a row added,
--     removed, edited, or newly crossing the threshold);
--   - any of the bare / overrides-v1..v4 content digest namespaces.
-- Body copied from 0078 with exactly one line changed (the `order by`).

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
  order by score desc, lc.lwin_id asc
  limit 1;
$$;

revoke all on function public.match_lwin(text, text, float) from public;
grant execute on function public.match_lwin(text, text, float) to authenticated;
