-- C07 (db audit 2026-08-23) — match_lwin / match_lwin_batch (0007) filter
-- on similarity(lower(col), ...) >= threshold, which the planner cannot
-- push down through lwin_catalog's GIN trigram indexes (those only
-- support the pg_trgm %, <->, and LIKE-family operators, never a bare
-- similarity() call). Every match_lwin call therefore sequential-scans
-- the whole lwin_catalog table and evaluates similarity() per row.
--
-- Verified (.../scratchpad/db-audit/verify/V5-perf-static.md, C07): at a
-- ~130,000-row lwin_catalog, the shipped code's own LWIN_MATCH_BATCH_SIZE
-- (300 rows/RPC call, src/domains/import/constants.ts) took 28.7s per
-- match_lwin_bulk call — against the authenticated role's 8s
-- statement_timeout — and the live PostgREST RPC returned a real HTTP 500
-- (SQLSTATE 57014, "canceling statement due to statement timeout") for
-- every chunk. Reproduced independently in this fix lane against a fresh
-- ~130,000-row synthetic catalog: identical HTTP 500 / 57014 at 8.44s
-- wall clock via the live RPC as an authenticated tenant.
--
-- Fix: replace the un-indexable similarity()>=threshold producer
-- comparison with an indexed % prefilter (lower(producer) %
-- lower(p_producer)), gated by a TRANSACTION-LOCAL setting of
-- pg_trgm.similarity_threshold — set_config(..., true), deliberately NOT
-- pg_trgm's own set_limit(), which sets a SESSION-scoped GUC via a plain
-- SET and would leak one caller's threshold into a later request that
-- reuses the same pooled connection. is_local = true reverts
-- automatically at the end of the calling transaction (one PostgREST
-- request = one transaction), so concurrent callers can never see each
-- other's threshold.
--
-- % is defined as similarity(a,b) >= the GUC value — verified empirically
-- in this lane (similarity(a,b) == GUC still evaluates % to true, i.e.
-- the boundary is >=, matching the original inline comparison exactly,
-- not a stricter >). That makes lower(lc.producer) % lower(p_producer)
-- (with the GUC set to p_threshold) an exact, index-eligible restatement
-- of the producer half of the original predicate — not an approximation.
--
-- Both original similarity() >= comparisons — producer AND name, at
-- their ORIGINAL two different thresholds (p_threshold and
-- p_threshold * 0.7) — are kept verbatim as residual filters after the %
-- prefilter. This is deliberate belt-and-suspenders: the % prefilter can
-- only narrow the candidate set that reaches those exact, unchanged
-- filters, so the returned match set is provably identical to the
-- original function's, regardless of any edge case in the operator's
-- floating-point boundary. Match-set equivalence was verified over 5,505
-- query pairs (exact catalog rows, case/typo/truncation variants, and
-- pure no-match garbage) against a ~130,000-row synthetic catalog,
-- comparing the OLD predicate shape and the NEW one row by row — see the
-- fix-lane report for the exact count and an explicit before/after check
-- of the C24 Pichon Baron / Pichon Lalande case (unchanged by this fix,
-- as required — C24 is a threshold/semantics bug owned by a different
-- fix lane; this migration does not touch match-acceptance semantics).
--
-- A second index on lower(display_name), used as a second % prefilter
-- ANDed via BitmapAnd, was tried and measured SLOWER in this lane's
-- testing: the shared GUC value needed to keep it a safe, no-false-
-- negative prefilter for the *name* comparison (p_threshold * 0.7, the
-- looser of the two thresholds) also loosens the *producer* prefilter,
-- and that lost more selectivity than the second index recovered. It
-- was dropped; only the producer index is added here.
--
-- match_lwin moves from `stable` to (implicitly) `volatile`: it now has
-- one side effect, a transaction-local GUC set, so `stable` would no
-- longer be an accurate declaration. This does not change how many
-- times per-row callers (match_lwin_bulk's LATERAL join, match_lwin_batch's
-- loop) invoke it — both already call it once per row with different
-- arguments every time, regardless of volatility.
--
-- Batch-size note: even with this fix, an adversarial worst case — every
-- row in one chunk sharing a very common producer-name word (e.g.
-- "Domaine", "Chateau") — can still approach the 8s budget at the
-- shipped LWIN_MATCH_BATCH_SIZE of 300 (measured ~12s for an
-- all-common-prefix 300-row batch against the same synthetic catalog;
-- ~4.4s for the same shape at 100 rows). This migration only touches the
-- database — src/domains/import/constants.ts is updated in the same fix
-- commit to reduce LWIN_MATCH_BATCH_SIZE so that worst case stays safely
-- inside the timeout; see the fix-lane report for the full measurements.
--
-- DOWN:
--   Restores the pre-fix match_lwin body (0007) verbatim and drops the
--   new index. See down/0078_match_lwin_trgm_fastpath.down.sql.

create index if not exists lwin_catalog_producer_lower_trgm_idx
  on public.lwin_catalog using gin (lower(producer) gin_trgm_ops);

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
