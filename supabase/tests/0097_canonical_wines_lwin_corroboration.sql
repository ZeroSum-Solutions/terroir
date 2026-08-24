-- P2 round-4 (D9 — scratchpad db-audit/verify/P2-critic-r3.md): regression
-- test for canonical_wines' insert policy LWIN corroboration gate. Round 1
-- only checked lwin7's FORMAT (7 digits); any authenticated tenant could
-- claim identity_status='lwin_verified' with an arbitrary or mismatched
-- 7-digit string, and canonical_wines_lwin7_idx being UNIQUE meant the
-- first writer owned that LWIN globally, forever, with no repair path for
-- a later victim (no UPDATE/DELETE policy on this table). Fixed: the
-- policy now requires the claimed lwin7 to name a real public.lwin_catalog
-- row (that table's PK is lwin_id — see 0003_wine_intelligence.sql) AND
-- that the submitted producer/cuvee actually resemble that row's
-- producer/display_name (match_lwin's own thresholds, reused: 0.3 /
-- 0.21). This closes BOTH forgery (a LWIN that doesn't exist at all) and
-- mis-binding (a REAL LWIN attached to the wrong wine).
begin;

select plan(5);

-- A real catalog entry to corroborate against.
insert into public.lwin_catalog (lwin_id, display_name, producer) values
  ('1112223', 'Chateau Corroboration Grand Vin', 'Chateau Corroboration');

-- Fixture: a real restaurant + membership (needed only so `authenticated`
-- has SOME real session context — canonical_wines has no ownership
-- check, but a real JWT is still required to hold the `authenticated`
-- role at all).
create temporary table _t0097_lwin_fixture (restaurant_id uuid, user_id uuid) on commit drop;
with new_restaurant as (
  insert into public.restaurants (name) values ('P2 LWIN Corroboration Test') returning id
)
insert into _t0097_lwin_fixture (restaurant_id, user_id)
select nr.id, u.id
from new_restaurant nr, (select id from auth.users where email = 'devlocal@terroir.test' limit 1) u;
insert into public.memberships (user_id, restaurant_id, role)
select user_id, restaurant_id, 'owner' from _t0097_lwin_fixture;
grant select on _t0097_lwin_fixture to authenticated;

set local role authenticated;
select set_config('request.jwt.claim.sub', (select user_id::text from _t0097_lwin_fixture), true);

-- 1. Forgery: a well-formatted lwin7 that names NO real catalog row at
-- all is rejected outright.
select throws_ok(
  $$
    insert into public.canonical_wines (producer, cuvee, producer_norm, cuvee_norm, identity_status, lwin7)
    values ('Nonexistent Producer', 'Nonexistent Wine', 'nonexistent producer', 'nonexistent wine', 'lwin_verified', '9999999')
  $$,
  '42501',
  null,
  'a forged lwin7 with no matching catalog row is rejected (RLS)'
);

-- 2. Mis-binding: a REAL lwin7 attached to producer/cuvee text that does
-- NOT resemble that catalog entry is also rejected — closing the "attach
-- a real LWIN to the wrong wine" vector, not just outright forgery.
select throws_ok(
  $$
    insert into public.canonical_wines (producer, cuvee, producer_norm, cuvee_norm, identity_status, lwin7)
    values ('Totally Different Producer', 'Totally Different Wine', 'totally different producer', 'totally different wine', 'lwin_verified', '1112223')
  $$,
  '42501',
  null,
  'a real lwin7 attached to non-corroborating producer/cuvee text is rejected (RLS)'
);

-- 3. Legitimate case: a real lwin7 WITH corroborating producer/cuvee text
-- still succeeds — the fix must not block genuine LWIN-verified inserts.
select lives_ok(
  $$
    insert into public.canonical_wines (producer, cuvee, producer_norm, cuvee_norm, identity_status, lwin7)
    values ('Chateau Corroboration', 'Grand Vin', 'chateau corroboration', 'grand vin', 'lwin_verified', '1112223')
  $$,
  'a real lwin7 with corroborating producer/cuvee text is accepted'
);
select isnt_empty(
  $$select 1 from public.canonical_wines where lwin7 = '1112223' and identity_status = 'lwin_verified'$$,
  'the legitimate lwin_verified row was actually written'
);

-- 4. Unverified inserts (the always-safe fallback) are completely
-- unaffected by this gate — no regression on the common path.
select lives_ok(
  $$
    insert into public.canonical_wines (producer, cuvee, producer_norm, cuvee_norm, identity_status)
    values ('Ordinary Producer', 'Ordinary Wine', 'ordinary producer', 'ordinary wine', 'unverified')
  $$,
  'an ordinary unverified insert (no lwin7 claim) is unaffected'
);

select * from finish();

rollback;
