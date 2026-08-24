-- P2 wine identity spine — resolve_wine_variants_bulk contract tests.
-- Runs as the `authenticated` role with a real JWT claim (not postgres),
-- so RLS on canonical_wines/wine_variants/wine_aliases is genuinely
-- exercised — the same discipline C28's verification used, and the only
-- way to prove the SECURITY INVOKER decision (0099's header comment) does
-- what it claims.
begin;

select plan(11);

-- Fixtures: a real restaurant + membership, created as postgres (table
-- owner bypasses RLS) since `authenticated` has no insert policy on
-- restaurants/memberships outside the signup trigger. Reuses the
-- dev-stack seed user (scripts/local/seed-local.mjs) rather than
-- inserting into auth.users directly, since a raw insert there would
-- also fire handle_new_user (0001) and needs columns only GoTrue
-- normally populates.
create temporary table _t9099_fixture (restaurant_id uuid, user_id uuid) on commit drop;
with new_restaurant as (
  insert into public.restaurants (name) values ('P2 RWVB Test') returning id
)
insert into _t9099_fixture (restaurant_id, user_id)
select nr.id, u.id
from new_restaurant nr, (select id from auth.users where email = 'devlocal@terroir.test' limit 1) u;
insert into public.memberships (user_id, restaurant_id, role)
select user_id, restaurant_id, 'owner' from _t9099_fixture;

-- The temp table was created as postgres; grant it to authenticated
-- before switching roles below, or every subsequent lookup against it
-- fails with permission denied.
grant select on _t9099_fixture to authenticated;

set local role authenticated;
select set_config('request.jwt.claim.sub', (select user_id::text from _t9099_fixture), true);

-- 1. First call: one genuinely new wine, one row.
select ok(
  (
    select canonical_created and variant_created
    from public.resolve_wine_variants_bulk(
      (select restaurant_id from _t9099_fixture),
      jsonb_build_array(jsonb_build_object(
        'idx', 0, 'producer_raw', 'Domaine Test', 'cuvee_raw', 'Cuvee One',
        'producer_norm', 'domaine test', 'cuvee_norm', 'cuvee one',
        'vintage', 2018, 'size_ml', 750
      ))
    )
  ),
  'a genuinely new variant creates both a canonical row and a variant row'
);

-- 2. Idempotency: re-run the SAME input — zero new rows anywhere.
select isnt_empty($$select 1 from public.canonical_wines where producer_norm = 'domaine test' and cuvee_norm = 'cuvee one'$$, 'sanity: the canonical row from step 1 exists');

select results_eq(
  $$
    with before_counts as (
      select
        (select count(*) from public.canonical_wines) as cw,
        (select count(*) from public.wine_variants) as wv,
        (select count(*) from public.wine_aliases) as wa
    ),
    resolved as (
      select * from public.resolve_wine_variants_bulk(
        (select restaurant_id from _t9099_fixture),
        jsonb_build_array(jsonb_build_object(
          'idx', 0, 'producer_raw', 'Domaine Test', 'cuvee_raw', 'Cuvee One',
          'producer_norm', 'domaine test', 'cuvee_norm', 'cuvee one',
          'vintage', 2018, 'size_ml', 750
        ))
      )
    ),
    after_counts as (
      select
        (select count(*) from public.canonical_wines) as cw,
        (select count(*) from public.wine_variants) as wv,
        (select count(*) from public.wine_aliases) as wa
    )
    select b.cw = a.cw and b.wv = a.wv and b.wa = a.wa
    from before_counts b, after_counts a
  $$,
  $$select true$$,
  'a re-run of identical input adds zero new canonical_wines/wine_variants/wine_aliases rows'
);

select results_eq(
  $$
    select canonical_created, variant_created
    from public.resolve_wine_variants_bulk(
      (select restaurant_id from _t9099_fixture),
      jsonb_build_array(jsonb_build_object(
        'idx', 0, 'producer_raw', 'Domaine Test', 'cuvee_raw', 'Cuvee One',
        'producer_norm', 'domaine test', 'cuvee_norm', 'cuvee one',
        'vintage', 2018, 'size_ml', 750
      ))
    )
  $$,
  $$select false, false$$,
  're-resolving an already-known variant reports canonical_created=false, variant_created=false'
);

-- 3. Same-batch duplicate: two DIFFERENT input rows resolving to the same
-- brand-new canonical wine (same producer/cuvee, different vintage) must
-- produce exactly ONE new canonical_wines row, not two.
select results_eq(
  $$
    with r as (
      select * from public.resolve_wine_variants_bulk(
        (select restaurant_id from _t9099_fixture),
        jsonb_build_array(
          jsonb_build_object(
            'idx', 0, 'producer_raw', 'Domaine Batch', 'cuvee_raw', 'Batch Cuvee',
            'producer_norm', 'domaine batch', 'cuvee_norm', 'batch cuvee',
            'vintage', 2019, 'size_ml', 750
          ),
          jsonb_build_object(
            'idx', 1, 'producer_raw', 'Domaine Batch', 'cuvee_raw', 'Batch Cuvee',
            'producer_norm', 'domaine batch', 'cuvee_norm', 'batch cuvee',
            'vintage', 2020, 'size_ml', 750
          )
        )
      )
    )
    select count(distinct canonical_wine_id)::int, count(distinct wine_variant_id)::int from r
  $$,
  $$select 1, 2$$,
  'two same-batch rows for the same new producer/cuvee at DIFFERENT vintages share one canonical row but get two distinct variant rows'
);

select is(
  (select count(*)::int from public.canonical_wines where producer_norm = 'domaine batch' and cuvee_norm = 'batch cuvee'),
  1,
  'exactly one canonical_wines row exists for the same-batch duplicate producer/cuvee'
);

-- 4. Negative test — the structural guarantee (property #1): adjacent
-- vintages and format siblings of an EXISTING wine must NOT collapse onto
-- the same wine_variant_id, even though they share a canonical_wine_id.
select results_eq(
  $$
    with r as (
      select * from public.resolve_wine_variants_bulk(
        (select restaurant_id from _t9099_fixture),
        jsonb_build_array(
          jsonb_build_object(
            'idx', 0, 'producer_raw', 'Domaine Vintage', 'cuvee_raw', 'Vintage Cuvee',
            'producer_norm', 'domaine vintage', 'cuvee_norm', 'vintage cuvee',
            'vintage', 2015, 'size_ml', 750
          ),
          jsonb_build_object(
            'idx', 1, 'producer_raw', 'Domaine Vintage', 'cuvee_raw', 'Vintage Cuvee',
            'producer_norm', 'domaine vintage', 'cuvee_norm', 'vintage cuvee',
            'vintage', 2016, 'size_ml', 750
          ),
          jsonb_build_object(
            'idx', 2, 'producer_raw', 'Domaine Vintage', 'cuvee_raw', 'Vintage Cuvee',
            'producer_norm', 'domaine vintage', 'cuvee_norm', 'vintage cuvee',
            'vintage', 2016, 'size_ml', 1500
          )
        )
      )
    )
    select count(distinct canonical_wine_id)::int, count(distinct wine_variant_id)::int from r
  $$,
  $$select 1, 3$$,
  'adjacent vintages (2015 vs 2016) and a format sibling (750ml vs 1500ml) never share a wine_variant_id, even though all three share one canonical_wine_id'
);

-- 5. LWIN7 equality wins over differing text: a row whose lwin7 matches
-- an existing canonical row but whose producer/cuvee text differs must
-- reuse that row (recording an alias), never create a duplicate.
-- Captured into a temp table (rather than a JOIN nested inside is()'s
-- scalar-subquery argument) so a mismatch is easy to diagnose.
create temporary table _t9099_lwin (call int, canonical_wine_id uuid) on commit drop;

insert into _t9099_lwin (call, canonical_wine_id)
select 1, r.canonical_wine_id
from public.resolve_wine_variants_bulk(
  (select restaurant_id from _t9099_fixture),
  jsonb_build_array(jsonb_build_object(
    'idx', 0, 'producer_raw', 'Domaine Test Misspelled', 'cuvee_raw', 'Cuvee One Typo',
    'producer_norm', 'domaine test misspelled', 'cuvee_norm', 'cuvee one typo',
    'vintage', 2018, 'size_ml', 750, 'lwin7', '1234567'
  ))
) r;

insert into _t9099_lwin (call, canonical_wine_id)
select 2, r.canonical_wine_id
from public.resolve_wine_variants_bulk(
  (select restaurant_id from _t9099_fixture),
  jsonb_build_array(jsonb_build_object(
    'idx', 0, 'producer_raw', 'Domaine Test Misspelled Again', 'cuvee_raw', 'Cuvee One Typo Again',
    'producer_norm', 'domaine test misspelled again', 'cuvee_norm', 'cuvee one typo again',
    'vintage', 2018, 'size_ml', 750, 'lwin7', '1234567'
  ))
) r;

select is(
  (select producer_norm from public.canonical_wines where id = (select canonical_wine_id from _t9099_lwin where call = 1)),
  'domaine test misspelled',
  'sanity: a brand-new lwin7 anchors a new canonical row under the input''s own text'
);

select is(
  (select canonical_wine_id from _t9099_lwin where call = 2),
  (select canonical_wine_id from _t9099_lwin where call = 1),
  'a second row with the SAME lwin7 but different text reuses the existing canonical row instead of creating a second one'
);

select isnt_empty(
  $$select 1 from public.wine_aliases
     where canonical_wine_id = (select id from public.canonical_wines where lwin7 = '1234567')
       and raw_producer = 'Domaine Test Misspelled Again'$$,
  'the differing-text row is recorded as an alias against the shared canonical wine, not a duplicate'
);

-- 11. D3 (round-2 critic finding, scratchpad db-audit/verify/P2-critic-r1.md):
-- "O'Brien's Vineyard" and "O.S. Brien Vineyard" used to normalize to the
-- IDENTICAL producer_norm ("brien o s vineyard") before the D3 fix to
-- src/domains/identity/normalize.ts. producer_norm/cuvee_norm below are
-- computed by hand using the FIXED normalizeProducerOrCuvee (this RPC
-- does no normalization itself — the caller always supplies it), same
-- cuvee ("Reserve") and vintage/size for both, mirroring the critic's own
-- live reproduction exactly.
create temporary table _t9099_d3 (label text, canonical_wine_id uuid) on commit drop;
insert into _t9099_d3 (label, canonical_wine_id)
select 'possessive_apostrophe', r.canonical_wine_id
from public.resolve_wine_variants_bulk(
  (select restaurant_id from _t9099_fixture),
  jsonb_build_array(jsonb_build_object(
    'idx', 0, 'producer_raw', 'O''Brien''s Vineyard', 'cuvee_raw', 'Reserve',
    'producer_norm', 'briens o vineyard', 'cuvee_norm', 'reserve',
    'vintage', 2019, 'size_ml', 750
  ))
) r;

insert into _t9099_d3 (label, canonical_wine_id)
select 'initials_with_periods', r.canonical_wine_id
from public.resolve_wine_variants_bulk(
  (select restaurant_id from _t9099_fixture),
  jsonb_build_array(jsonb_build_object(
    'idx', 0, 'producer_raw', 'O.S. Brien Vineyard', 'cuvee_raw', 'Reserve',
    'producer_norm', 'brien o s vineyard', 'cuvee_norm', 'reserve',
    'vintage', 2019, 'size_ml', 750
  ))
) r;

select isnt(
  (select canonical_wine_id from _t9099_d3 where label = 'possessive_apostrophe'),
  (select canonical_wine_id from _t9099_d3 where label = 'initials_with_periods'),
  'D3 fix: a possessive apostrophe and period-separated initials no longer collide into one canonical wine'
);

select * from finish();

rollback;
