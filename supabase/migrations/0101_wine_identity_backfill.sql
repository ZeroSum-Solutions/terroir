-- 0101_wine_identity_backfill.sql
-- P2 — wine identity spine, part 5: data migration for pre-existing wines
-- rows. Idempotent (every pass is scoped to "where wine_variant_id is
-- null"), following the three-pass structure 0054_wine_lineages.sql
-- already used for its own backfill.
--
-- Normalization here is public.identity_normalize_text() (0097) — the
-- same function that GENERATES canonical_wines' identity key, so this
-- pass cannot key a row differently from any other writer even though it
-- runs as the table owner with RLS bypassed.
--
-- P2 ROUND-6 CORRECTION, recorded rather than quietly fixed: this header
-- previously called the SQL normalization a "best-effort approximation"
-- of src/domains/identity/normalize.ts and argued the divergence was
-- acceptable because its failure mode is always "creates one extra
-- canonical/variant row a later exact match could have reused," never
-- "merges two different wines." That argument was sound only while the
-- SQL side merely COMPARED. Once round 5 moved identity-key derivation
-- server-side, the same divergence became capable of merging two
-- different wines, and it immediately did: the SQL function lacked
-- normalize.ts's possessive-suffix rule, so "O'Brien's Vineyard" and
-- "O.S. Brien Vineyard" — the exact D3 pair round 2 separated — both
-- normalized to "brien o s vineyard" and would have shared one canonical
-- identity. Measured, not theorised: 10 of 17 frozen golden vectors
-- agreed before the fix, 17 of 17 after. The two implementations are now
-- asserted equivalent unconditionally by
-- src/domains/identity/normalize.test.ts rather than assumed close
-- enough, and the "never merges two different wines" guarantee is
-- restored by that test rather than by argument.
--
-- On a fresh local stack `wines` is empty, so this is a no-op there; it
-- exists for production-safety discipline, matching this codebase's habit
-- of never assuming a clean slate.
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
  -- P2 ROUND-5 (D9-residual — scratchpad db-audit/verify/P2-critic-r4.md):
  -- reuses public.identity_normalize_text() (0097) instead of duplicating
  -- this exact expression inline — it now also backs the LWIN
  -- corroboration gate below, and one implementation is easier to keep
  -- correct than several copies that "agree on the same bug because they
  -- hardcode the same literals" (the round-4 critic's framing of why
  -- three independent copies of the OLD fuzzy check weren't actually
  -- independent verification).
  public.identity_normalize_text(w.producer) as producer_norm,
  public.identity_normalize_text(w.name) as cuvee_norm,
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

-- P2 ROUND-5 FIX (D9-residual): identity_status = 'lwin_verified' added.
-- Without it, this join would match ANY canonical_wines row carrying
-- n.lwin7 regardless of whether it was ever corroborated — the same
-- "unverified-squat" hole closed on the resolve_wine_variants_bulk path
-- (0099) and now also closed here, plus universally by 0097's
-- canonical_wines_lwin7_requires_verified CHECK CONSTRAINT (this filter
-- is defense-in-depth on top of that invariant).
insert into _identity_backfill_resolved (wine_id, canonical_wine_id, restaurant_id, vintage, size_ml)
select n.wine_id, cw.id, n.restaurant_id, n.vintage, n.size_ml
from _identity_backfill_norm n
join public.canonical_wines cw
  on n.lwin7 is not null and cw.lwin7 = n.lwin7 and cw.identity_status = 'lwin_verified';

insert into _identity_backfill_resolved (wine_id, canonical_wine_id, restaurant_id, vintage, size_ml)
select n.wine_id, cw.id, n.restaurant_id, n.vintage, n.size_ml
from _identity_backfill_norm n
join public.canonical_wines cw
  on cw.producer_norm = n.producer_norm and cw.cuvee_norm = n.cuvee_norm
where n.wine_id not in (select wine_id from _identity_backfill_resolved);

-- P2 ROUND-4/5 HISTORY (D9, then D9-residual — scratchpad
-- db-audit/verify/P2-critic-r3.md and -r4.md): every row still
-- unresolved at this point is about to CREATE a canonical_wines row
-- below, claiming identity_status='lwin_verified' whenever its lwin7 is
-- set. This migration runs as the table owner and BYPASSES RLS entirely
-- — 0097's insert-policy corroboration cannot reach it, and (before
-- round 5) neither could 0097's CHECK CONSTRAINT, since it didn't exist
-- yet — so this backfill needs its own copy of the corroboration LOGIC
-- regardless (0097's canonical_wines_lwin7_requires_verified CHECK
-- CONSTRAINT now backstops the OUTCOME universally, but this UPDATE is
-- what makes the CREATE decision correct in the first place, not merely
-- constraint-safe). wines.lwin_id is itself settable by any tenant
-- member via a plain UPDATE on wines with no catalog validation (the
-- wines update policy is is_member(restaurant_id) with no column
-- restriction), so this is the same forgery/mis-binding vector as the
-- resolve_wine_variants_bulk path, triggered by a one-time migration over
-- whatever wines rows exist at deploy time rather than a live RPC call.
--
-- Round 4 gated this with pg_trgm similarity() at match_lwin's own
-- ranking thresholds (0.3/0.21) — the wrong tool for a permanent,
-- unsupervised decision: similarity('Chateau Pichon Longueville Baron',
-- 'Chateau Pichon Longueville Comtesse de Lalande') = 0.55, comfortably
-- above 0.3, for two REAL, DISTINCT estates. Round 5 replaces it with
-- identity_normalize_text() (see 0097's definition and the corresponding
-- fix in 0099 for the full Baron/Lalande write-up): EXACT equality on
-- producer, TOKEN SUBSET on cuvee (display_name commonly combines
-- producer + wine name, so exact-string cuvee matching would reject
-- every legitimate case) — both deterministic, neither a score, so this
-- separates genuinely different producers while still tolerating
-- accent/case/spacing/punctuation-only differences. A
-- row that fails corroboration is downgraded (lwin7 stripped) to
-- identity_status='unverified' below, not dropped from the backfill
-- entirely — it still gets a real identity via its own text, matching
-- this file's own already-documented risk tolerance ("creates one extra
-- canonical/variant row a later exact match could have reused," never
-- "merges two different wines").
-- P2 ROUND-6 FIX (D9-residual #2): reads n.producer_norm/n.cuvee_norm —
-- the values this pass actually resolves and stores on — rather than
-- recomputing the normalization inline, for the same reason 0099's gate
-- does. Equal by construction (both come from identity_normalize_text
-- over the same source text), so no outcome changes; what changes is
-- that a later edit can no longer make the checked value and the keyed
-- value drift apart, which is the entire D9-residual bug class.
update _identity_backfill_norm n
set lwin7 = null
where n.wine_id not in (select wine_id from _identity_backfill_resolved)
  and n.lwin7 is not null
  and not exists (
    select 1 from public.lwin_catalog lc
    where lc.lwin_id = n.lwin7
      and n.producer_norm = public.identity_normalize_text(lc.producer)
      and string_to_array(n.cuvee_norm, ' ') <@ string_to_array(public.identity_normalize_text(lc.display_name), ' ')
  );

-- P2 ROUND-6 (D9-residual #2): producer_norm/cuvee_norm are omitted —
-- canonical_wines GENERATES them (0097). This migration runs as the
-- table owner and bypasses RLS, so before round 6 it was the one path
-- that could write ANY identity key with no policy in its way; the
-- generated columns now bind it to n.producer/n.name exactly like every
-- other caller. The stored key stays byte-identical to the
-- n.producer_norm this statement still uses for DISTINCT ON and as the
-- conflict target, since _identity_backfill_norm derived it with the
-- same function call.
with new_canon as (
  insert into public.canonical_wines (
    producer, cuvee, lwin7, identity_status,
    created_by_restaurant_id
  )
  select distinct on (n.producer_norm, n.cuvee_norm)
    n.producer, n.name, n.lwin7,
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
