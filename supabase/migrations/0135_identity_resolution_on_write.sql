-- 0135 — identity resolution on write.
--
-- WHAT WAS BROKEN
--
-- 0097-0101 built the identity spine: canonical_wines (global),
-- wine_variants (tenant-scoped), wine_aliases, the merge RPCs, and
-- resolve_wine_variants_bulk (0099) as "the dedup service". 0101 then
-- backfilled every wines row that existed at that instant.
--
-- Nothing ever called resolve_wine_variants_bulk again. Before this
-- migration, `grep -rn '.rpc("resolve_wine_variants_bulk"' src/` returned
-- nine hits, all nine inside src/domains/identity/tenant-isolation.test.ts.
-- Zero production callers. Every wine created after 0101 ran therefore
-- carried wine_variant_id IS NULL, and — via the
-- wines_derive_canonical_wine_id BEFORE trigger (0098), which derives
-- canonical from variant — canonical_wine_id IS NULL, permanently.
--
-- Measured on a freshly seeded local stack immediately before this file
-- was written: 250 wines, 0 with wine_variant_id, 0 with
-- canonical_wine_id, and canonical_wines / wine_variants / wine_aliases
-- all empty. The spine was not partially wired; it held no rows at all.
--
-- The cost is not cosmetic. src/lib/wine-intelligence/xwines-profile.ts
-- prefers the canonical_wine_id link when it is set (0132) and silently
-- falls back to producer/cuvee text matching when it is not — so the
-- X-Wines corpus join, the reason 0131-0134 exist, ran permanently in its
-- degraded mode.
--
-- WHAT THIS DOES
--
-- 1. find_or_create_wines_batch (0079) resolves identity for the wines it
--    creates or finds, in ONE bulk call after its loop, and writes
--    wines.wine_variant_id. canonical_wine_id follows from 0098's trigger
--    with no second write.
--
-- 2. backfill_wine_identity(uuid) — a re-runnable repair function that
--    resolves every wines row still carrying a null wine_variant_id, and a
--    one-shot call to it here. This covers the rows created between 0101
--    and this migration, and every row in any environment seeded after
--    0101 — where 0101 ran against an empty table and did nothing at all,
--    which is why a freshly seeded stack measured 0/250 above.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--
-- apply_import_batch_chunk — the CSV import path, and by volume the
-- overwhelming majority of wine creation — is NOT touched here. That is
-- not an oversight, it is the design: docs/plans/2026-08-23-p2-identity-
-- spine.md §9 and §12 both state that resolve_wine_variants_bulk is called
-- "once per batch of unique variants, not once per CSV row, and BEFORE
-- apply_import_batch_chunk's existing per-row loop", and that P2's
-- interface to P3 is exactly that call, made by P3's TypeScript caller.
-- Hooking resolve into the per-row loop here would directly violate the
-- performance contract §9 signs up to (C10) for a path that already
-- handles 4,000-8,000 rows per session.
--
-- Nor does this change the import DEDUP KEY. src/domains/import/dedup-key
-- .ts's header describes swapping computeWineIdentityKey's four-tuple for
-- the resolved wine_variant_id, and 0107's own comment anticipates the
-- matching SQL-side swap. That changes WHICH rows collapse into one wine
-- during an import — a behavioural change with real blast radius, gated on
-- P3's own evidence. This migration only populates identity; it changes no
-- existing merge, dedup or matching semantics.
--
-- Reversibility: the down restores 0079's function body verbatim and drops
-- backfill_wine_identity. The backfilled identity rows are left in place —
-- they are correct data, and 0101 set the same precedent for its own
-- backfill.

-------------------------------------------------------------------------------
-- 1. find_or_create_wines_batch — resolve after create
-------------------------------------------------------------------------------

create or replace function public.find_or_create_wines_batch(
  p_restaurant_id uuid,
  p_wines         jsonb
)
returns uuid[]
language plpgsql
security invoker
set search_path = public
as $$
declare
  wine_ids uuid[];
  wine_record jsonb;
  wine_id uuid;
  i int;
  v_unique_ids uuid[];
  v_payload jsonb;
begin
  wine_ids := array[]::uuid[];

  for i in 0 .. jsonb_array_length(p_wines) - 1 loop
    wine_record := p_wines -> i;

    -- Try to find existing wine
    select w.id into wine_id
    from public.wines w
    where w.restaurant_id = p_restaurant_id
      and lower(w.producer) = lower(wine_record ->> 'producer')
      and lower(w.name)     = lower(wine_record ->> 'name')
      and coalesce(w.vintage, 0) = coalesce((wine_record ->> 'vintage')::int, 0)
      and w.size_ml = coalesce((wine_record ->> 'size_ml')::int, 750)
    limit 1;

    if wine_id is not null then
      -- Fill in missing fields
      update public.wines
      set varietal = coalesce(wines.varietal, wine_record ->> 'varietal'),
          region   = coalesce(wines.region, wine_record ->> 'region'),
          country  = coalesce(wines.country, wine_record ->> 'country')
      where id = wine_id
        and (wines.varietal is null or wines.region is null or wines.country is null);
    else
      -- Insert new wine
      insert into public.wines (restaurant_id, name, producer, vintage, varietal, region, country, size_ml)
      values (
        p_restaurant_id,
        wine_record ->> 'name',
        wine_record ->> 'producer',
        (wine_record ->> 'vintage')::int,
        wine_record ->> 'varietal',
        wine_record ->> 'region',
        wine_record ->> 'country',
        coalesce((wine_record ->> 'size_ml')::int, 750)
      )
      on conflict (restaurant_id, lower(producer), lower(name), coalesce(vintage, 0), size_ml)
      do update set
        varietal = coalesce(excluded.varietal, wines.varietal),
        region   = coalesce(excluded.region, wines.region),
        country  = coalesce(excluded.country, wines.country)
      returning id into wine_id;
    end if;

    wine_ids := wine_ids || wine_id;
  end loop;

  -- ---------------------------------------------------------------------
  -- Identity resolution (0135). One bulk call for the whole batch, after
  -- the loop — never once per wine — matching §9's "once per batch of
  -- unique variants" contract.
  -- ---------------------------------------------------------------------
  if coalesce(array_length(wine_ids, 1), 0) > 0 then
    -- De-duplicate first: a p_wines payload naming the same wine twice
    -- yields the same id twice, and _rwvb_input.idx is a PRIMARY KEY.
    select array_agg(distinct wid) into v_unique_ids
    from unnest(wine_ids) as t(wid)
    where wid is not null;

    -- Raw text only. resolve_wine_variants_bulk derives producer_norm and
    -- cuvee_norm itself via identity_normalize_text (the P2 round-5 fix);
    -- a caller-supplied identity key is exactly the cross-tenant hole that
    -- fix closed, so none is sent.
    select jsonb_agg(
             jsonb_build_object(
               'idx',          u.ord - 1,
               'producer_raw', w.producer,
               'cuvee_raw',    w.name,
               'vintage',      w.vintage,
               'size_ml',      w.size_ml
             )
             order by u.ord
           )
      into v_payload
      from unnest(v_unique_ids) with ordinality as u(wine_id, ord)
      join public.wines w on w.id = u.wine_id;

    begin
      -- Rows whose producer/cuvee collapse to nothing under normalization
      -- are dropped by resolve_wine_variants_bulk rather than given a
      -- placeholder identity, so they simply never come back and keep a
      -- null wine_variant_id. That is the designed outcome (0099), not a
      -- failure: an unresolvable name is a data-quality problem for a
      -- human, not a reason to refuse to create the wine.
      update public.wines w
         set wine_variant_id = r.wine_variant_id
        from public.resolve_wine_variants_bulk(p_restaurant_id, v_payload) r
        join unnest(v_unique_ids) with ordinality as u(wine_id, ord)
          on u.ord - 1 = r.idx
       where w.id = u.wine_id
         and w.restaurant_id = p_restaurant_id
         and r.wine_variant_id is not null
         and w.wine_variant_id is distinct from r.wine_variant_id;
    exception when others then
      -- Identity resolution must never be able to fail a wine write. A
      -- caller creating a bottle cares that the bottle exists; a spine
      -- that cannot resolve it right now is repairable later (the backfill
      -- below is re-runnable by design), whereas a lost write is not.
      --
      -- This is a WARNING, not a swallow: it reaches the Postgres log with
      -- the real SQLSTATE and message every time it fires, and the wine
      -- keeps a null wine_variant_id, which is itself the queryable signal
      -- that resolution did not happen.
      raise warning
        'find_or_create_wines_batch: identity resolution failed for restaurant % (%): %',
        p_restaurant_id, sqlstate, sqlerrm;
    end;
  end if;

  return wine_ids;
end;
$$;

revoke all on function public.find_or_create_wines_batch(uuid, jsonb) from public;
grant execute on function public.find_or_create_wines_batch(uuid, jsonb) to authenticated;

comment on function public.find_or_create_wines_batch(uuid, jsonb) is
  'Find-or-create wines for a restaurant, then resolve their identity '
  '(wines.wine_variant_id; canonical_wine_id follows from 0098''s trigger) '
  'in one bulk resolve_wine_variants_bulk call. Resolution failure warns '
  'and leaves wine_variant_id null rather than failing the write — see '
  '0135 for why.';

-------------------------------------------------------------------------------
-- 2. backfill_wine_identity — a real, re-runnable repair function
-------------------------------------------------------------------------------
--
-- Deliberately a FUNCTION, not the inline DO block this started as. Three
-- callers need it, and a DO block serves exactly one of them:
--
--   * this migration, once, for the rows that exist right now;
--   * scripts/seed-local-supabase.mjs, which upserts straight into `wines`
--     rather than going through find_or_create_wines_batch — so without
--     this call every freshly seeded database (every CI run, every local
--     reset) would reproduce the exact null-identity state 0135 exists to
--     fix, and the spine would look broken again the moment anyone reset;
--   * an operator repairing rows that a warned-and-continued resolution
--     failure in find_or_create_wines_batch left behind.
--
-- SECURITY INVOKER, and granted to service_role only. It is a maintenance
-- operation over every tenant's rows, not something an authenticated
-- session has any reason to run; resolve_wine_variants_bulk's own RLS
-- posture is unchanged either way, since restaurant_id is passed
-- explicitly per tenant.
--
-- Idempotent: it only ever considers rows with wine_variant_id IS NULL,
-- and resolve_wine_variants_bulk is find-or-create against unique indexes.
-- Running it twice resolves nothing the second time.

create or replace function public.backfill_wine_identity(
  p_restaurant_id uuid default null
)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_restaurant record;
  v_ids uuid[];
  v_payload jsonb;
  v_resolved int;
  v_total int := 0;
  v_cursor uuid;
begin
  for v_restaurant in
    select distinct restaurant_id
    from public.wines
    where wine_variant_id is null
      and (p_restaurant_id is null or restaurant_id = p_restaurant_id)
  loop
    -- Page by id, and never revisit a page. Re-querying "still null" each
    -- pass would hand back the rows that cannot be normalized forever:
    -- with 500 or more such rows in one tenant the first page would
    -- resolve nothing, and a resolved-count exit would then abandon every
    -- resolvable row queued behind them.
    v_cursor := '00000000-0000-0000-0000-000000000000'::uuid;

    loop
      -- 500 at a time so one very large tenant cannot build a single
      -- enormous jsonb payload.
      select array_agg(id order by id) into v_ids
      from (
        select id
        from public.wines
        where restaurant_id = v_restaurant.restaurant_id
          and wine_variant_id is null
          and id > v_cursor
        order by id
        limit 500
      ) s;

      exit when v_ids is null or array_length(v_ids, 1) is null;

      v_cursor := v_ids[array_length(v_ids, 1)];

      -- Raw text only — see the note in find_or_create_wines_batch above.
      select jsonb_agg(
               jsonb_build_object(
                 'idx',          u.ord - 1,
                 'producer_raw', w.producer,
                 'cuvee_raw',    w.name,
                 'vintage',      w.vintage,
                 'size_ml',      w.size_ml
               )
               order by u.ord
             )
        into v_payload
        from unnest(v_ids) with ordinality as u(wine_id, ord)
        join public.wines w on w.id = u.wine_id;

      with resolved as (
        select r.idx, r.wine_variant_id
        from public.resolve_wine_variants_bulk(v_restaurant.restaurant_id, v_payload) r
        where r.wine_variant_id is not null
      )
      update public.wines w
         set wine_variant_id = resolved.wine_variant_id
        from resolved
        join unnest(v_ids) with ordinality as u(wine_id, ord)
          on u.ord - 1 = resolved.idx
       where w.id = u.wine_id;

      get diagnostics v_resolved = row_count;
      v_total := v_total + v_resolved;
    end loop;
  end loop;

  return v_total;
end;
$$;

revoke all on function public.backfill_wine_identity(uuid) from public;
grant execute on function public.backfill_wine_identity(uuid) to service_role;

-- 0099 granted resolve_wine_variants_bulk to `authenticated` only, because
-- at the time its only intended caller was a signed-in session. service_role
-- therefore could not execute it at all — caught by running the real
-- reset-and-seed path, where the seeder (service_role) failed with
-- "permission denied for function resolve_wine_variants_bulk".
--
-- The fix is this grant, NOT making backfill_wine_identity SECURITY
-- DEFINER. Definer rights would run resolve_wine_variants_bulk as the
-- migration role, and 0099's header is explicit that invoker mode is the
-- entire mechanism enforcing its tenant boundary: it carries no manual
-- is_member() check on purpose, so that a caller targeting a foreign
-- restaurant_id fails on the real RLS policy rather than a hand-rolled
-- check that could drift from it. Definer rights would silently delete
-- that boundary.
--
-- Granting service_role concedes nothing: service_role already bypasses
-- RLS on wine_variants and canonical_wines and could write both tables
-- directly. This only lets it reach them through the guarded, normalizing
-- path instead of around it.
grant execute on function public.resolve_wine_variants_bulk(uuid, jsonb) to service_role;

comment on function public.backfill_wine_identity(uuid) is
  'Resolve wines.wine_variant_id for every row still carrying null, one '
  'tenant at a time, 500 rows per resolve_wine_variants_bulk call. '
  'Idempotent and re-runnable. Called by 0135, by the local seeder (which '
  'writes wines directly), and by operators repairing rows left unresolved '
  'by a warned resolution failure. Returns the number of rows resolved.';

-------------------------------------------------------------------------------
-- 3. Run it once for the rows that exist now
-------------------------------------------------------------------------------

do $$
declare
  v_total int;
begin
  select public.backfill_wine_identity() into v_total;
  raise notice '0135 backfill: resolved identity for % wines row(s)', v_total;
end;
$$;
