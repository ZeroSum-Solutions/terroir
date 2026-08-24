-- P2 round-4/5 (D9, then D9-residual — scratchpad db-audit/verify/
-- P2-critic-r3.md and -r4.md): regression test for canonical_wines'
-- insert-policy LWIN corroboration gate.
--
-- Round 1 only checked lwin7's FORMAT. Round 4 added a corroboration
-- check using pg_trgm similarity() at match_lwin's own ranking
-- thresholds (0.3/0.21) — the wrong tool: that threshold is tuned to
-- tolerate false positives because a human reviews match_lwin's
-- suggestions before anything is written; this policy makes a permanent,
-- cross-tenant, unrepairable decision. Round 5's critic proved live that
-- similarity('Chateau Pichon Longueville Baron', 'Chateau Pichon
-- Longueville Comtesse de Lalande') = 0.55 — two REAL, DISTINCT Bordeaux
-- estates, comfortably above 0.3 — and reproduced the full cross-tenant
-- hijack through it using nothing but the system's own real data (no
-- attacker needed). Round 5 also found the corroboration check could be
-- bypassed ENTIRELY via the 'unverified' branch, which placed no
-- constraint on lwin7 at all, combined with the LWIN-exact match having
-- no identity_status filter.
--
-- Round 5 fixes: identity_normalize_text() (deterministic — exact
-- equality on producer, token-subset on cuvee, never a score) replaces
-- the fuzzy check, PLUS a new canonical_wines_lwin7_requires_verified
-- CHECK CONSTRAINT that makes "lwin7 set on an unverified row" impossible
-- to insert from any path whatsoever.
begin;

select plan(13);

-- Two real catalog entries: the exact Baron/Lalande pair that broke
-- round 4, plus the original corroboration-check catalog row.
insert into public.lwin_catalog (lwin_id, display_name, producer) values
  ('1112223', 'Chateau Corroboration Grand Vin', 'Chateau Corroboration'),
  ('7654321', 'Chateau Pichon Longueville Baron Grand Vin', 'Chateau Pichon Longueville Baron');

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
    insert into public.canonical_wines (producer, cuvee, identity_status, lwin7)
    values ('Nonexistent Producer', 'Nonexistent Wine', 'lwin_verified', '9999999')
  $$,
  '42501',
  null,
  'a forged lwin7 with no matching catalog row is rejected (RLS)'
);

-- 2. CONTROL — garbage pair (live-measured by the round-5 critic at
-- 0.16/0 similarity against the '1112223' catalog row under the OLD
-- fuzzy check): producer/cuvee text totally unrelated to the real wine is
-- rejected. Without this control, a gate that rejects EVERYTHING (as
-- broken as one that accepts everything) would look identical to a
-- correct one.
select throws_ok(
  $$
    insert into public.canonical_wines (producer, cuvee, identity_status, lwin7)
    values ('Totally Different Producer', 'Totally Different Wine', 'lwin_verified', '1112223')
  $$,
  '42501',
  null,
  'CONTROL: garbage producer/cuvee text (0.16/0 similarity under the old fuzzy check) is rejected'
);

-- 3. THE DECISIVE PAIR — Pichon Baron vs Pichon Longueville Comtesse de
-- Lalande, scored 0.55/0.55 similarity by the OLD fuzzy check (comfortably
-- above its 0.3/0.21 thresholds) and the exact pair that broke round 4.
-- Lalande's OWN correct text, submitted against Baron's real lwin7, must
-- be rejected — this is not a "similar enough" match, it is a genuinely
-- different producer that happens to share a long common prefix.
select throws_ok(
  $$
    insert into public.canonical_wines (producer, cuvee, identity_status, lwin7)
    values ('Chateau Pichon Longueville Comtesse de Lalande', 'Grand Vin', 'lwin_verified', '7654321')
  $$,
  '42501',
  null,
  'Pichon Lalande''s own correct text against Pichon Baron''s real lwin7 is rejected (the exact pair that broke round 4''s fuzzy gate)'
);

-- 4. Baron's OWN correct text against the SAME real lwin7 succeeds —
-- proving the gate is precise, not merely maximally strict.
select lives_ok(
  $$
    insert into public.canonical_wines (producer, cuvee, identity_status, lwin7)
    values ('Chateau Pichon Longueville Baron', 'Grand Vin', 'lwin_verified', '7654321')
  $$,
  'Pichon Baron''s own correct text against its own real lwin7 is accepted'
);
select is(
  (select producer from public.canonical_wines where lwin7 = '7654321'),
  'Chateau Pichon Longueville Baron',
  'the verified row under this lwin7 is Baron''s, never Lalande''s'
);

-- 5. Legitimate case (original corroboration-check fixture): a real
-- lwin7 WITH corroborating producer/cuvee text still succeeds. Catalog
-- display_name ('Chateau Corroboration Grand Vin') combines producer +
-- wine name — exercising the token-SUBSET cuvee check, not exact-string
-- equality, since an exact-string check against display_name would
-- reject this (and every other) legitimate match.
select lives_ok(
  $$
    insert into public.canonical_wines (producer, cuvee, identity_status, lwin7)
    values ('Chateau Corroboration', 'Grand Vin', 'lwin_verified', '1112223')
  $$,
  'a real lwin7 with corroborating producer/cuvee text is accepted (token-subset cuvee check)'
);
select isnt_empty(
  $$select 1 from public.canonical_wines where lwin7 = '1112223' and identity_status = 'lwin_verified'$$,
  'the legitimate lwin_verified row was actually written'
);

-- 6. THE UNVERIFIED-SQUAT PATH (round 5's more severe finding): before
-- the canonical_wines_lwin7_requires_verified CHECK CONSTRAINT, a row
-- could claim identity_status='unverified' while STILL carrying a real
-- lwin7 — the corroboration check only ever gated the 'lwin_verified'
-- branch above, so this path bypassed it entirely, and the LWIN-exact
-- match in resolve_wine_variants_bulk had no identity_status filter, so
-- this squatted lwin7 would still capture every later legitimate import
-- carrying the same number. The CHECK CONSTRAINT closes this
-- unconditionally: lwin7 may be non-null ONLY when identity_status =
-- 'lwin_verified', regardless of whether the corroboration check would
-- have passed or failed for this specific row.
select throws_ok(
  $$
    insert into public.canonical_wines (producer, cuvee, identity_status, lwin7)
    values ('Squatter Import Co', 'Junk Label', 'unverified', '1112223')
  $$,
  '23514',
  null,
  'an unverified row cannot carry ANY lwin7 (even one it would otherwise fail to corroborate) — the CHECK CONSTRAINT closes the bypass unconditionally'
);

-- 7. Unverified inserts with NO lwin7 claim (the always-safe fallback)
-- are completely unaffected by any of this — no regression on the
-- common path.
select lives_ok(
  $$
    insert into public.canonical_wines (producer, cuvee, identity_status)
    values ('Ordinary Producer', 'Ordinary Wine', 'unverified')
  $$,
  'an ordinary unverified insert (no lwin7 claim) is unaffected'
);

-- 8. ROUND 6 — D9-residual #2, THE ATTACK THIS ROUND EXISTS TO CLOSE.
-- Until round 6 the corroboration gate above validated producer/cuvee
-- while the row was KEYED on producer_norm/cuvee_norm, a different pair
-- of caller-supplied fields that nothing bound to the first. So an
-- attacker did not have to defeat the gate at all: submit raws for a
-- wine you legitimately own, whose lwin7 genuinely corroborates (rows 4
-- and 6 above prove those are accepted), together with norms naming the
-- VICTIM's wine. The gate passes on the raws and the row lands on the
-- victim's identity key — permanently, since canonical_wines_identity_idx
-- is UNIQUE and this table grants authenticated no UPDATE or DELETE.
--
-- Live-reproduced against this stack before the fix: a row reading
-- producer='Attacker Real Estate' was written with producer_norm=
-- 'estate real victim', and the victim's own correct import through
-- resolve_wine_variants_bulk then bound to it (canonical_match_method=
-- 'exact', canonical_created=false).
--
-- The columns are now GENERATED ALWAYS from producer/cuvee (0097), so
-- the attack is not rejected by a check — it is unrepresentable. Note
-- the SQLSTATE: 428C9 is raised by the column definition itself, BEFORE
-- any RLS policy is consulted, which is why it also holds for
-- service_role, the table owner and 0101's backfill. Both columns are
-- asserted separately so that regenerating only one of them still fails
-- this suite.
select throws_ok(
  $$
    insert into public.canonical_wines (producer, cuvee, producer_norm, identity_status, lwin7)
    values ('Chateau Pichon Longueville Baron', 'Grand Vin', 'estate real victim', 'lwin_verified', '7654321')
  $$,
  '428C9',
  null,
  'THE ATTACK: honest raws that genuinely corroborate, plus a forged producer_norm naming a victim''s identity, is refused by the generated column'
);

select throws_ok(
  $$
    insert into public.canonical_wines (producer, cuvee, cuvee_norm, identity_status, lwin7)
    values ('Chateau Pichon Longueville Baron', 'Grand Vin', 'forged cuvee key', 'lwin_verified', '7654321')
  $$,
  '428C9',
  null,
  'the same attack via cuvee_norm is refused independently — regenerating only one column would not silently pass'
);

-- 9. The generated key is not merely unforgeable, it is the RIGHT value:
-- exactly identity_normalize_text(producer), token-sorted. Without this
-- the two assertions above would still pass if the columns were
-- generated from some other expression entirely.
select is(
  (select producer_norm || ' | ' || cuvee_norm from public.canonical_wines where lwin7 = '7654321'),
  'baron chateau longueville pichon | grand vin',
  'the generated identity key is exactly identity_normalize_text() of the row''s own producer/cuvee, token-sorted'
);

-- 10. Fail-closed on an identity that collapses to nothing: punctuation-
-- only producer text generates NULL, which the column's NOT NULL refuses
-- rather than inventing a placeholder identity. 0099 and 0101 both delete
-- such rows before inserting, so this closes the direct-insert path only.
select throws_ok(
  $$
    insert into public.canonical_wines (producer, cuvee, identity_status)
    values ('---', 'Ordinary Wine', 'unverified')
  $$,
  '23502',
  null,
  'a producer that normalizes to nothing is refused (NOT NULL on the generated key), never given a placeholder identity'
);

select * from finish();

rollback;
