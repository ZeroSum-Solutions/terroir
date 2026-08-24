-- 0101_wine_identity_backfill.sql
-- P2 — wine identity spine, part 5: data migration for pre-existing wines
-- rows. Idempotent (every pass is scoped to "where wine_variant_id is
-- null"), following the three-pass structure 0054_wine_lineages.sql
-- already used for its own backfill.
--
-- This is a best-effort SQL-side approximation of
-- src/domains/identity/normalize.ts, explicitly NOT a perfect mirror of
-- it: Postgres unaccent()'s dictionary and JS NFKD-plus-manual-œ/æ-folding
-- will not agree on every input. Stated, not hidden — per
-- docs/plans/2026-08-23-p2-identity-spine.md §3: the failure mode this
-- divergence can cause is always "creates one extra canonical/variant row
-- a later exact match could have reused," never "merges two different
-- wines," because this backfill still only ever matches/creates via the
-- same exact-key uniqueness constraints resolve_wine_variants_bulk uses —
-- it never fuzzy-matches. On a fresh local stack `wines` is empty, so this
-- is a no-op there; it exists for production-safety discipline, matching
-- this codebase's habit of never assuming a clean slate.
--
-- Uses explicit `drop table if exists` cleanup rather than
-- `on commit drop`: unlike resolve_wine_variants_bulk (0099), which
-- creates its scratch table inside one plpgsql function call and is
-- therefore guaranteed to run within a single transaction regardless of
-- caller behavior, this is a top-level migration file whose transaction
-- boundaries are the migration runner's to decide — explicit drops make
-- cleanup correct either way.
create extension if not exists unaccent;

drop table if exists _identity_backfill_norm;
create temporary table _identity_backfill_norm as
select
  w.id as wine_id,
  w.restaurant_id,
  w.producer,
  w.name,
  w.vintage,
  w.size_ml,
  (
    select nullif(string_agg(t, ' ' order by t), '')
    from unnest(string_to_array(
      trim(regexp_replace(lower(unaccent(w.producer)), '[^a-z0-9]+', ' ', 'g')),
      ' '
    )) as t
    where t <> ''
  ) as producer_norm,
  (
    select nullif(string_agg(t, ' ' order by t), '')
    from unnest(string_to_array(
      trim(regexp_replace(lower(unaccent(w.name)), '[^a-z0-9]+', ' ', 'g')),
      ' '
    )) as t
    where t <> ''
  ) as cuvee_norm,
  case when w.lwin_id ~ '^[0-9]{7}' then substr(w.lwin_id, 1, 7) else null end as lwin7
from public.wines w
where w.wine_variant_id is null;

-- Rows whose producer/name collapse to nothing under normalization (e.g.
-- punctuation-only text) can't be identity-resolved by this pass — leave
-- them for manual review rather than inventing a placeholder identity.
delete from _identity_backfill_norm
where producer_norm is null or cuvee_norm is null;

-------------------------------------------------------------------------------
-- Pass B: canonical_wines — two-phase exact-key match/create, same shape
-- as resolve_wine_variants_bulk (0099): LWIN7 wins over text, DISTINCT ON
-- collapses same-batch duplicates, ON CONFLICT DO NOTHING handles a
-- concurrent writer.
-------------------------------------------------------------------------------
drop table if exists _identity_backfill_resolved;
create temporary table _identity_backfill_resolved (
  wine_id           uuid primary key,
  canonical_wine_id uuid not null,
  restaurant_id     uuid not null,
  vintage           int,
  size_ml           int not null
);

insert into _identity_backfill_resolved (wine_id, canonical_wine_id, restaurant_id, vintage, size_ml)
select n.wine_id, cw.id, n.restaurant_id, n.vintage, n.size_ml
from _identity_backfill_norm n
join public.canonical_wines cw on n.lwin7 is not null and cw.lwin7 = n.lwin7;

insert into _identity_backfill_resolved (wine_id, canonical_wine_id, restaurant_id, vintage, size_ml)
select n.wine_id, cw.id, n.restaurant_id, n.vintage, n.size_ml
from _identity_backfill_norm n
join public.canonical_wines cw
  on cw.producer_norm = n.producer_norm and cw.cuvee_norm = n.cuvee_norm
where n.wine_id not in (select wine_id from _identity_backfill_resolved);

-- D9 fix (scratchpad db-audit/verify/P2-critic-r3.md): every row still
-- unresolved at this point is about to CREATE a canonical_wines row
-- below, claiming identity_status='lwin_verified' whenever its lwin7 is
-- set. This migration runs as the table owner and BYPASSES RLS entirely
-- — 0097's insert-policy corroboration fix provides this backfill ZERO
-- protection, so it needs its own, independent copy of the same gate
-- (resolve_wine_variants_bulk, 0099, carries the RPC-side copy). Without
-- it, wines.lwin_id — itself settable by any tenant member via a plain
-- UPDATE on wines with no catalog validation, since the wines
-- update policy is is_member(restaurant_id) with no column restriction —
-- becomes exactly the same forgery/mis-binding vector D9 closes on the
-- resolve_wine_variants_bulk path, except triggered by a one-time
-- migration over whatever wines rows already exist at deploy time rather
-- than a live RPC call. Same thresholds as 0097/0099, reused rather than
-- reinvented: 0.3 producer / 0.21 name similarity against the real
-- public.lwin_catalog row (lwin_catalog.lwin_id is that table's primary
-- key; there is no separate "lwin7" column there). A row that fails
-- corroboration is downgraded (lwin7 stripped) to identity_status =
-- 'unverified' below, not dropped from the backfill entirely — it still
-- gets a real identity via its own text, matching this file's own
-- already-documented risk tolerance ("creates one extra canonical/
-- variant row a later exact match could have reused," never "merges two
-- different wines").
update _identity_backfill_norm n
set lwin7 = null
where n.wine_id not in (select wine_id from _identity_backfill_resolved)
  and n.lwin7 is not null
  and not exists (
    select 1 from public.lwin_catalog lc
    where lc.lwin_id = n.lwin7
      and similarity(lower(n.producer), lower(lc.producer)) >= 0.3
      and similarity(lower(n.name), lower(lc.display_name)) >= 0.21
  );

with new_canon as (
  insert into public.canonical_wines (
    producer, cuvee, producer_norm, cuvee_norm, lwin7, identity_status,
    created_by_restaurant_id
  )
  select distinct on (n.producer_norm, n.cuvee_norm)
    n.producer, n.name, n.producer_norm, n.cuvee_norm, n.lwin7,
    case when n.lwin7 is not null then 'lwin_verified' else 'unverified' end,
    n.restaurant_id
  from _identity_backfill_norm n
  where n.wine_id not in (select wine_id from _identity_backfill_resolved)
  order by n.producer_norm, n.cuvee_norm, n.wine_id
  on conflict (producer_norm, cuvee_norm) do nothing
  returning id, producer_norm, cuvee_norm
)
insert into _identity_backfill_resolved (wine_id, canonical_wine_id, restaurant_id, vintage, size_ml)
select n.wine_id, nc.id, n.restaurant_id, n.vintage, n.size_ml
from _identity_backfill_norm n
join new_canon nc on nc.producer_norm = n.producer_norm and nc.cuvee_norm = n.cuvee_norm
where n.wine_id not in (select wine_id from _identity_backfill_resolved);

-- Lost-the-conflict-race read-back (a concurrent writer, or an earlier
-- in-batch DISTINCT ON representative that this row's own producer/cuvee
-- pair matched but which wasn't visible as a "new_canon" row above).
insert into _identity_backfill_resolved (wine_id, canonical_wine_id, restaurant_id, vintage, size_ml)
select n.wine_id, cw.id, n.restaurant_id, n.vintage, n.size_ml
from _identity_backfill_norm n
join public.canonical_wines cw
  on cw.producer_norm = n.producer_norm and cw.cuvee_norm = n.cuvee_norm
where n.wine_id not in (select wine_id from _identity_backfill_resolved);

-------------------------------------------------------------------------------
-- Pass C: wine_variants — identical two-phase pattern keyed on
-- (restaurant_id, canonical_wine_id, coalesce(vintage,0), size_ml).
-------------------------------------------------------------------------------
drop table if exists _identity_backfill_variant;
create temporary table _identity_backfill_variant (
  wine_id         uuid primary key,
  wine_variant_id uuid not null
);

insert into _identity_backfill_variant (wine_id, wine_variant_id)
select r.wine_id, wv.id
from _identity_backfill_resolved r
join public.wine_variants wv
  on wv.restaurant_id = r.restaurant_id
 and wv.canonical_wine_id = r.canonical_wine_id
 and coalesce(wv.vintage, 0) = coalesce(r.vintage, 0)
 and wv.size_ml = r.size_ml;

with new_variants as (
  insert into public.wine_variants (restaurant_id, canonical_wine_id, vintage, size_ml)
  select distinct on (r.restaurant_id, r.canonical_wine_id, coalesce(r.vintage, 0), r.size_ml)
    r.restaurant_id, r.canonical_wine_id, r.vintage, r.size_ml
  from _identity_backfill_resolved r
  where r.wine_id not in (select wine_id from _identity_backfill_variant)
  order by r.restaurant_id, r.canonical_wine_id, coalesce(r.vintage, 0), r.size_ml, r.wine_id
  on conflict (restaurant_id, canonical_wine_id, coalesce(vintage, 0), size_ml) do nothing
  returning id, restaurant_id, canonical_wine_id, vintage, size_ml
)
insert into _identity_backfill_variant (wine_id, wine_variant_id)
select r.wine_id, nv.id
from _identity_backfill_resolved r
join new_variants nv
  on nv.restaurant_id = r.restaurant_id
 and nv.canonical_wine_id = r.canonical_wine_id
 and coalesce(nv.vintage, 0) = coalesce(r.vintage, 0)
 and nv.size_ml = r.size_ml
where r.wine_id not in (select wine_id from _identity_backfill_variant);

insert into _identity_backfill_variant (wine_id, wine_variant_id)
select r.wine_id, wv.id
from _identity_backfill_resolved r
join public.wine_variants wv
  on wv.restaurant_id = r.restaurant_id
 and wv.canonical_wine_id = r.canonical_wine_id
 and coalesce(wv.vintage, 0) = coalesce(r.vintage, 0)
 and wv.size_ml = r.size_ml
where r.wine_id not in (select wine_id from _identity_backfill_variant);

-------------------------------------------------------------------------------
-- Pass D: set wines.wine_variant_id. wines.canonical_wine_id is derived
-- by the wines_derive_canonical_wine_id trigger (0098) whenever
-- wine_variant_id changes, including from this bulk UPDATE — no separate
-- step needed here, and no reason to bypass the trigger: it always
-- computes the same value this backfill would set by hand, by
-- construction.
-------------------------------------------------------------------------------
update public.wines w
set wine_variant_id = v.wine_variant_id
from _identity_backfill_variant v
where w.id = v.wine_id;

drop table if exists _identity_backfill_variant;
drop table if exists _identity_backfill_resolved;
drop table if exists _identity_backfill_norm;
