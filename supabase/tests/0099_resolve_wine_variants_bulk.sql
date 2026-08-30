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
-- restaurants/memberships outside the signup trigger. Reuses an existing
-- seeded auth user rather than inserting into auth.users directly, since
-- a raw insert there would also fire handle_new_user (0001) and needs
-- columns only GoTrue normally populates.
--
-- The lookup PREFERS the dev-stack user but does not require it.
-- scripts/local/seed-local.mjs creates DEV_BYPASS_EMAIL, which only
-- DEFAULTS to devlocal@terroir.test — so on any stack that sets that
-- variable (or that was seeded by scripts/seed-local-supabase.mjs, which
-- creates owner+local@terroir.test instead) the hardcoded address does
-- not exist. The cross join then yields no rows, the fixture table is
-- empty, request.jwt.claim.sub is set to NULL, no membership exists, and
-- the very first resolve_wine_variants_bulk call dies on wine_variants'
-- RLS insert policy — aborting the file before a single one of the 11
-- planned tests reports. That failure reads exactly like an RLS
-- regression in the function under test and is not one, which is the
-- specific trap this ordering avoids. Any authenticated user works here;
-- the test needs a user id to hang a membership on, not a named person.
create temporary table _t9099_fixture (restaurant_id uuid, user_id uuid) on commit drop;
with new_restaurant as (
  insert into public.restaurants (name) values ('P2 RWVB Test') returning id
)
insert into _t9099_fixture (restaurant_id, user_id)
select nr.id, u.id
from new_restaurant nr,
     (select id from auth.users
       order by (email = 'devlocal@terroir.test') desc, created_at
       limit 1) u;
insert into public.memberships (user_id, restaurant_id, role)
select user_id, restaurant_id, 'owner' from _t9099_fixture;

-- The temp table was created as postgres; grant it to authenticated
-- before switching roles below, or every subsequent lookup against it
-- fails with permission denied.
grant select on _t9099_fixture to authenticated;

-- D9/D9-residual fixture (round 4, corrected round 5): a real
-- lwin_catalog row for the LWIN-corroboration test below (step 5).
-- Round 4's fixture used fuzzy-similarity-tolerant text ("Domaine Test
-- Misspelled") that does NOT survive round 5's deterministic exact-match
-- fix (an extra whole word is not a formatting difference — see
-- 0097/0099's Pichon Baron/Lalande write-up for why that distinction
-- matters). This fixture instead uses a GENUINE data-entry-error class
-- (accent presence, case, spacing) that the deterministic check is
-- specifically designed to still tolerate — live-verified: "Chateau Test
-- Domaine" and "CHATEAU  TEST DOMAINE" both normalize identically to
-- "Château Test Domaine", and "Cuvee Un"/"cuvee un" are both a token
-- subset of "Château Test Domaine Cuvée Un". Inserted as postgres (table
-- owner), before the role switch below: lwin_catalog has no insert
-- policy for authenticated, only select.
insert into public.lwin_catalog (lwin_id, display_name, producer) values
  ('1234567', 'Château Test Domaine Cuvée Un', 'Château Test Domaine');

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
        'vintage', 2018, 'size_ml', 750
      ))
    )
  ),
  'a genuinely new variant creates both a canonical row and a variant row'
);

-- 2. Idempotency: re-run the SAME input — zero new rows anywhere.
select isnt_empty($$select 1 from public.canonical_wines where producer_norm = public.identity_normalize_text('Domaine Test') and cuvee_norm = public.identity_normalize_text('Cuvee One')$$, 'sanity: the canonical row from step 1 exists');

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
            'vintage', 2019, 'size_ml', 750
          ),
          jsonb_build_object(
            'idx', 1, 'producer_raw', 'Domaine Batch', 'cuvee_raw', 'Batch Cuvee',
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
  (select count(*)::int from public.canonical_wines where producer_norm = public.identity_normalize_text('Domaine Batch') and cuvee_norm = public.identity_normalize_text('Batch Cuvee')),
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
            'vintage', 2015, 'size_ml', 750
          ),
          jsonb_build_object(
            'idx', 1, 'producer_raw', 'Domaine Vintage', 'cuvee_raw', 'Vintage Cuvee',
            'vintage', 2016, 'size_ml', 750
          ),
          jsonb_build_object(
            'idx', 2, 'producer_raw', 'Domaine Vintage', 'cuvee_raw', 'Vintage Cuvee',
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
--
-- D9/D9-residual fix (round 4, corrected round 5 — scratchpad
-- db-audit/verify/P2-critic-r3.md and -r4.md): lwin7 must corroborate
-- against a real public.lwin_catalog row (see 0097's insert policy)
-- before resolve_wine_variants_bulk will let it create a lwin_verified
-- canonical row — a bare 7-digit string with no catalog backing is
-- downgraded to unverified instead, and (round 5) corroboration is now
-- DETERMINISTIC (exact-normalized-producer + token-subset-cuvee), not a
-- similarity score. The catalog fixture this test's lwin7 needs is
-- seeded up top (as postgres, before the role switch to authenticated —
-- lwin_catalog has no insert policy for authenticated, only select).
create temporary table _t9099_lwin (call int, canonical_wine_id uuid) on commit drop;

insert into _t9099_lwin (call, canonical_wine_id)
select 1, r.canonical_wine_id
from public.resolve_wine_variants_bulk(
  (select restaurant_id from _t9099_fixture),
  jsonb_build_array(jsonb_build_object(
    'idx', 0, 'producer_raw', 'Chateau Test Domaine', 'cuvee_raw', 'Cuvee Un',
    'vintage', 2018, 'size_ml', 750, 'lwin7', '1234567'
  ))
) r;

insert into _t9099_lwin (call, canonical_wine_id)
select 2, r.canonical_wine_id
from public.resolve_wine_variants_bulk(
  (select restaurant_id from _t9099_fixture),
  jsonb_build_array(jsonb_build_object(
    'idx', 0, 'producer_raw', 'CHATEAU  TEST DOMAINE', 'cuvee_raw', 'cuvee un',
    'vintage', 2018, 'size_ml', 750, 'lwin7', '1234567'
  ))
) r;

select is(
  (select identity_status from public.canonical_wines where id = (select canonical_wine_id from _t9099_lwin where call = 1)),
  'lwin_verified',
  'sanity: a brand-new lwin7 that deterministically corroborates anchors a new lwin_verified canonical row'
);

select is(
  (select canonical_wine_id from _t9099_lwin where call = 2),
  (select canonical_wine_id from _t9099_lwin where call = 1),
  'a second row with the SAME lwin7 but different CASE/SPACING (a genuine data-entry-error class, not a different producer) reuses the existing canonical row instead of creating a second one'
);

select isnt_empty(
  $$select 1 from public.wine_aliases
     where canonical_wine_id = (select id from public.canonical_wines where lwin7 = '1234567')
       and raw_producer = 'CHATEAU  TEST DOMAINE'$$,
  'the differing-text row is recorded as an alias against the shared canonical wine, not a duplicate'
);

-- 11. D3 (round-2 critic finding, scratchpad db-audit/verify/P2-critic-r1.md):
-- "O'Brien's Vineyard" and "O.S. Brien Vineyard" used to normalize to the
-- IDENTICAL producer_norm ("brien o s vineyard"), collapsing two
-- plausibly-different real producers into one canonical identity.
--
-- P2 ROUND-6: this test got sharper rather than weaker. It used to hand
-- the RPC pre-computed norms, so it only ever proved that the CALLER's
-- TypeScript normalizer had been fixed — the server would have accepted
-- any two strings the caller chose to distinguish. Now the caller sends
-- only raw text and the server derives the identity key itself, so this
-- exercises the real thing: public.identity_normalize_text() must make
-- the same distinction normalize.ts does.
--
-- It caught exactly that. Round 5 moved key derivation server-side but
-- the SQL function had no possessive-suffix rule, so both names again
-- normalized to "brien o s vineyard" — D3 reintroduced, this time as a
-- genuine cross-wine over-merge rather than a caller-side bug. The rule
-- was ported into identity_normalize_text() in round 6; this test is
-- what fails if it is ever dropped again.
create temporary table _t9099_d3 (label text, canonical_wine_id uuid) on commit drop;
insert into _t9099_d3 (label, canonical_wine_id)
select 'possessive_apostrophe', r.canonical_wine_id
from public.resolve_wine_variants_bulk(
  (select restaurant_id from _t9099_fixture),
  jsonb_build_array(jsonb_build_object(
    'idx', 0, 'producer_raw', 'O''Brien''s Vineyard', 'cuvee_raw', 'Reserve',
    'vintage', 2019, 'size_ml', 750
  ))
) r;

insert into _t9099_d3 (label, canonical_wine_id)
select 'initials_with_periods', r.canonical_wine_id
from public.resolve_wine_variants_bulk(
  (select restaurant_id from _t9099_fixture),
  jsonb_build_array(jsonb_build_object(
    'idx', 0, 'producer_raw', 'O.S. Brien Vineyard', 'cuvee_raw', 'Reserve',
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
