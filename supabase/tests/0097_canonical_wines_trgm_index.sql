-- P2 wine identity spine — trigram index usage proof.
--
-- The direct regression test for not repeating C07 (verified in
-- scratchpad db-audit/verify/V5-perf-static.md: match_lwin's
-- `similarity(...) >= threshold` predicate cannot use a GIN trigram
-- index at all, forcing a full sequential scan on every call — at
-- production LWIN-catalog volume this made every 300-row import chunk
-- exceed the 8s statement_timeout, a hard HTTP 500, not just "slow").
--
-- canonical_wines' GIN trigram indexes (0097) are queried with the `%`
-- operator under pg_trgm.similarity_threshold, per
-- docs/plans/2026-08-23-p2-identity-spine.md §3/§9 — never
-- `similarity(...) >= x`. This proves that operator choice actually
-- reaches the index at a realistic row count, with EXPLAIN (ANALYZE,
-- BUFFERS) evidence, not just "the index exists."
begin;

select plan(2);

-- A temp helper so EXPLAIN's command output (not normally queryable) can
-- be captured as rows and asserted on with pgTAP.
create or replace function pg_temp.explain_lines(q text) returns setof text
language plpgsql as $$
begin
  return query execute 'explain (analyze, buffers) ' || q;
end;
$$;

-- Realistic volume, not a handful of rows: at 8,000 rows, and even at
-- 130,000 (V5-perf-static's own synthetic lwin_catalog volume — the real
-- reproduction of C07), an earlier draft of this test measured the
-- Seq-Scan-vs-Bitmap-Index-Scan cost comparison as too close for ANALYZE's
-- sampling variance to reliably decide — exactly the trap that hid C07 in
-- an empty local lwin_catalog during earlier review, just one order of
-- magnitude further out. 300,000 rows (confirmed stable across repeated
-- runs) gives the Bitmap Index Scan a decisive cost margin. 30 genuinely
-- distinct multi-word producer/cuvee templates (not a numbered
-- "Producer N" series — those all share one dominant trigram prefix and
-- made selectivity too poor for ANY plan to be selective). Trailing g
-- keeps (producer_norm, cuvee_norm) unique per row (required by
-- canonical_wines_identity_idx) while each ~4,300-row group still shares
-- real trigram overlap, mirroring V5-perf-static's synthetic-catalog
-- methodology ("a mix of ~30 real producer/wine-name templates so
-- trigram matching behaves realistically").
with templates as (
  select
    unnest(array[
      'Chateau Belair Vauban', 'Domaine Jean Grivot', 'Bodega Ruiz Alvarez',
      'Tenuta Marchetti Colombo', 'Weingut Kessler Baumann', 'Quinta Silva Ferreira',
      'Clos Saint Martin', 'Maison Lefevre Girard', 'Cantina Romano Greco',
      'Finca Delgado Navarro', 'Domaine Rousseau Fabre', 'Chateau Eperon Reserve',
      'Bodega Mendez Campos', 'Weingut Falkenstein Estate', 'Tenuta Villa Conti',
      'Domaine Perrin Aubert', 'Maison Bonnet Fontaine', 'Quinta Rocha Nogueira',
      'Clos Vougeot Estate', 'Chateau Roquefeuille', 'Bodega Herrera Salinas',
      'Domaine Colin Gros', 'Tenuta Moretti Ricci', 'Weingut Steiner Wagner',
      'Finca Ibarra Contreras', 'Maison Jadot Morey', 'Cantina Barbieri Fontana',
      'Domaine Cathiard Roumier', 'Chateau Desire Belisle', 'Bodega Reyes Vidal'
    ]) as producer,
    unnest(array[
      'Vosne Romanee Premier Cru', 'Saint Aubin Blanc', 'Clos Vougeot Grand Cru',
      'Meursault Perrieres', 'Chambolle Musigny', 'Grand Vin Reserve',
      'Cuvee Prestige Vieilles Vignes', 'Estate Selection', 'Old Vine Reserve',
      'Single Vineyard Blend', 'Gran Reserva Crianza', 'Barrel Select Cuvee',
      'Riserva Speciale', 'Terroir Selection', 'Heritage Blend',
      'Vintage Selection Reserve', 'Estate Bottled', 'Grand Cru Classe',
      'Premier Cru Selection', 'Signature Cuvee', 'Legacy Reserve',
      'Founders Selection', 'Classic Estate Blend', 'Reserva Especial',
      'Single Block Reserve', 'Tradition Cuvee', 'Grand Reserve Blend',
      'Estate Vineyard Selection', 'Old Vines Cuvee', 'Barrel Reserve'
    ]) as cuvee,
    generate_series(0, 29) as idx
)
insert into public.canonical_wines (producer, cuvee, producer_norm, cuvee_norm)
select
  t.producer || ' ' || g,
  t.cuvee || ' ' || g,
  lower(t.producer) || ' ' || g,
  lower(t.cuvee) || ' ' || g
from generate_series(1, 300000) g
join templates t on t.idx = g % 30;

analyze public.canonical_wines;

set pg_trgm.similarity_threshold = 0.3;

select ok(
  exists (
    select 1 from pg_temp.explain_lines(
      $q$select id from public.canonical_wines where producer_norm % 'chateau belair vauban'$q$
    ) as line
    where line ilike '%Bitmap Index Scan%canonical_wines_producer_trgm_idx%'
       or line ilike '%Index Scan%canonical_wines_producer_trgm_idx%'
  )
  and not exists (
    select 1 from pg_temp.explain_lines(
      $q$select id from public.canonical_wines where producer_norm % 'chateau belair vauban'$q$
    ) as line
    where line ilike '%Seq Scan%canonical_wines%'
  ),
  'producer_norm % query uses canonical_wines_producer_trgm_idx (GIN), not a Seq Scan'
);

select ok(
  exists (
    select 1 from pg_temp.explain_lines(
      $q$select id from public.canonical_wines where cuvee_norm % 'vosne romanee premier cru'$q$
    ) as line
    where line ilike '%Bitmap Index Scan%canonical_wines_cuvee_trgm_idx%'
       or line ilike '%Index Scan%canonical_wines_cuvee_trgm_idx%'
  )
  and not exists (
    select 1 from pg_temp.explain_lines(
      $q$select id from public.canonical_wines where cuvee_norm % 'vosne romanee premier cru'$q$
    ) as line
    where line ilike '%Seq Scan%canonical_wines%'
  ),
  'cuvee_norm % query uses canonical_wines_cuvee_trgm_idx (GIN), not a Seq Scan'
);

select * from finish();

rollback;
