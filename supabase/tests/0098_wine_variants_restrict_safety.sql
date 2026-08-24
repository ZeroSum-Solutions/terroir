-- P2 round-3 (D1-residual — scratchpad db-audit/verify/P2-critic-r2.md):
-- permanent regression test for wines_variant_tenant_fk's ON DELETE
-- RESTRICT. Round 1 shipped CASCADE (destroyed wines rows + audit
-- children on a variant delete — CRITICAL). Round 2 switched to SET
-- NULL, reasoning that RESTRICT was unsafe because a restaurant teardown
-- fires wine_variants.restaurant_id's and wines.restaurant_id's sibling
-- CASCADEs in an order Postgres does not guarantee, and RESTRICT would
-- raise a spurious violation if wine_variants' side won that race. The
-- round-2 critic proved that reasoning wrong by FORCING the reversal
-- (not just arguing about it) and showing RESTRICT still never fires.
-- This file encodes that same forced-reversal proof as a standing
-- regression test, so a future Postgres version or a future edit to
-- this FK can't silently reintroduce either failure mode without a test
-- catching it.
begin;

select plan(4);

-- Fixture: a real restaurant + canonical_wine + wine_variant + wines row
-- with wine_variant_id set, one audit child (bottle_closeouts) planted so
-- a RESTRICT-vs-destroy distinction would be visible either way.
insert into public.restaurants (id, name) values
  ('10000000-0000-0000-0000-000000000001', 'D1 RESTRICT Safety Test');
insert into public.canonical_wines (id, producer, cuvee) values
  ('10000000-0000-0000-0000-000000000002', 'Restrict Safety Producer', 'Restrict Safety Cuvee');
insert into public.wine_variants (id, restaurant_id, canonical_wine_id, vintage, size_ml) values
  ('10000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 2020, 750);
insert into public.wines (id, restaurant_id, name, producer, vintage, size_ml, wine_variant_id) values
  ('10000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'Restrict Safety Wine', 'Restrict Safety Producer', 2020, 750, '10000000-0000-0000-0000-000000000003');
insert into public.bottle_closeouts (restaurant_id, wine_id, preservation_method, theoretical_remaining_ml, actual_remaining_ml) values
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000004', 'none', 0, 0);

-- 1. RESTRICT actually blocks a standalone delete — the check trigger is
-- live, not dead code, and the wines row + its audit child survive.
select throws_ok(
  $$ delete from public.wine_variants where id = '10000000-0000-0000-0000-000000000003' $$,
  '23503',
  'update or delete on table "wine_variants" violates foreign key constraint "wines_variant_tenant_fk" on table "wines"',
  'RESTRICT blocks a standalone wine_variants delete with a live wines row pointing at it'
);
select is(
  (select count(*)::int from public.wines where id = '10000000-0000-0000-0000-000000000004'),
  1,
  'the wines row survives the blocked delete attempt'
);

-- 2. THE DECISIVE TEST: force a reversal of the wines/wine_variants
-- restaurant_id cascade firing order, diagnostically confirm the reversal
-- really happened, and prove restaurant teardown still succeeds under
-- RESTRICT even so. Drop+recreate wines_restaurant_id_fkey so its RI
-- triggers get fresh, LATER OIDs than wine_variants_restaurant_id_fkey's
-- (which fire first by default, in ascending OID order).
alter table public.wines drop constraint wines_restaurant_id_fkey;
alter table public.wines add constraint wines_restaurant_id_fkey
  foreign key (restaurant_id) references public.restaurants(id) on delete cascade;

-- Diagnostic table + AFTER DELETE triggers proving the real execution
-- order via clock_timestamp(), not inferred from OIDs.
create temporary table _t0098_order (tbl text, deleted_id uuid, at timestamptz) on commit drop;
create or replace function pg_temp._t0098_log() returns trigger language plpgsql as $$
begin
  insert into _t0098_order (tbl, deleted_id, at) values (TG_TABLE_NAME, old.id, clock_timestamp());
  return old;
end;
$$;
create trigger _t0098_diag_wines after delete on public.wines
  for each row execute function pg_temp._t0098_log();
create trigger _t0098_diag_variants after delete on public.wine_variants
  for each row execute function pg_temp._t0098_log();

insert into public.restaurants (id, name) values
  ('10000000-0000-0000-0000-000000000005', 'D1 RESTRICT Forced-Reversal Test');
insert into public.canonical_wines (id, producer, cuvee) values
  ('10000000-0000-0000-0000-000000000006', 'Forced Reversal Producer', 'Forced Reversal Cuvee');
insert into public.wine_variants (id, restaurant_id, canonical_wine_id, vintage, size_ml) values
  ('10000000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000006', 2021, 750);
insert into public.wines (id, restaurant_id, name, producer, vintage, size_ml, wine_variant_id) values
  ('10000000-0000-0000-0000-000000000008', '10000000-0000-0000-0000-000000000005', 'Forced Reversal Wine', 'Forced Reversal Producer', 2021, 750, '10000000-0000-0000-0000-000000000007');

delete from public.restaurants where id = '10000000-0000-0000-0000-000000000005';

select ok(
  (select at from _t0098_order where tbl = 'wine_variants' and deleted_id = '10000000-0000-0000-0000-000000000007')
    < (select at from _t0098_order where tbl = 'wines' and deleted_id = '10000000-0000-0000-0000-000000000008'),
  'the forced trigger-OID swap genuinely reversed the firing order — wine_variants deleted before wines, confirmed by real timestamps, not inferred'
);
select is(
  (select count(*)::int from public.wines where restaurant_id = '10000000-0000-0000-0000-000000000005'),
  0,
  'restaurant teardown under RESTRICT still succeeds with zero errors even under a diagnostically-proven-reversed cascade order'
);

select * from finish();

rollback;
