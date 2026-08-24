-- 0079_wine_rpc_invoker_boundary.sql
--
-- C01 (db audit 2026-08-23) — find_or_create_wine, find_or_create_wines_batch,
-- and match_lwin_batch are SECURITY DEFINER and trust a caller-supplied
-- p_restaurant_id / p_wine_ids with zero membership check. PostgREST grants
-- EXECUTE on all three to `authenticated` (not just service_role), and
-- signup is self-service (handle_new_user provisions a fresh restaurant +
-- owner membership for anyone who registers an email) — so "authenticated"
-- here means any signed-up user of any tenant, not a privileged app role.
--
-- Verified (.../scratchpad/db-audit/verify/V1-tenancy.md, C01): a tenant-B
-- session called all three RPCs against tenant A's restaurant_id / wine ids
-- and wrote/mutated tenant A's catalog rows every time — HTTP 200, confirmed
-- as superuser afterward. Anon correctly 401s (no EXECUTE grant to anon),
-- so PostgREST-as-authenticated is the entire reachable surface.
--
-- Fix: convert all three from SECURITY DEFINER to SECURITY INVOKER instead
-- of bolting an explicit is_member() guard onto each. `wines` already has
-- complete, correct RLS (members-only select/insert/update/delete, keyed on
-- is_member(restaurant_id)) — as SECURITY INVOKER, every SELECT/INSERT/
-- UPDATE these functions perform against wines is subject to that RLS for
-- the ACTUAL calling role, so:
--   - a member's own restaurant: identical behavior to before (their own
--     grants + RLS already allow everything these functions do).
--   - a non-member's restaurant_id: the INSERT/UPDATE inside the function
--     hits the WITH CHECK/USING clause and fails with 42501 ("new row
--     violates row-level security policy"), atomically — no partial
--     writes, no silent cross-tenant landing.
--   - match_lwin_batch's driving SELECT ... WHERE id = ANY(p_wine_ids) is
--     itself RLS-filtered, so a foreign wine id is simply invisible to the
--     loop rather than needing a hand-rolled membership join — the same
--     "invisible, not rejected" idiom apply_import_batch_chunk (0076)
--     already uses for exactly this shape of problem.
-- Converting to INVOKER is preferred over an explicit per-function guard:
-- it can't drift out of sync with wines' own policies, and it is enforced
-- on every statement inside the function, not just a single top-of-function
-- check.
--
-- match_lwin (called from inside match_lwin_batch) stays SECURITY DEFINER,
-- unchanged — it reads the global, non-tenant-scoped lwin_catalog reference
-- table, a separate, already-reviewed surface (0007/0078) untouched here.
--
-- DOWN: restores all three functions' pre-fix SECURITY DEFINER bodies
-- verbatim (0002 for find_or_create_wine, 0006 for find_or_create_wines_batch,
-- 0007 for match_lwin_batch — 0078 only replaced match_lwin's body, never
-- match_lwin_batch's). See down/0079_wine_rpc_invoker_boundary.down.sql.

create or replace function public.find_or_create_wine(
  p_restaurant_id uuid,
  p_name          text,
  p_producer      text,
  p_vintage       int default null,
  p_varietal      text default null,
  p_region        text default null,
  p_country       text default null,
  p_size_ml       int default 750
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  wine_id uuid;
begin
  -- Try to find existing wine
  select id into wine_id
  from public.wines
  where restaurant_id = p_restaurant_id
    and lower(producer) = lower(p_producer)
    and lower(name)     = lower(p_name)
    and coalesce(vintage, 0) = coalesce(p_vintage, 0)
    and size_ml = p_size_ml
  limit 1;

  if wine_id is not null then
    -- Fill in missing fields if we have better data now
    update public.wines
    set varietal = coalesce(wines.varietal, p_varietal),
        region   = coalesce(wines.region, p_region),
        country  = coalesce(wines.country, p_country)
    where id = wine_id
      and (wines.varietal is null or wines.region is null or wines.country is null);
    return wine_id;
  end if;

  -- Insert new wine
  insert into public.wines (restaurant_id, name, producer, vintage, varietal, region, country, size_ml)
  values (p_restaurant_id, p_name, p_producer, p_vintage, p_varietal, p_region, p_country, p_size_ml)
  on conflict (restaurant_id, lower(producer), lower(name), coalesce(vintage, 0), size_ml)
  do update set
    varietal = coalesce(excluded.varietal, wines.varietal),
    region   = coalesce(excluded.region, wines.region),
    country  = coalesce(excluded.country, wines.country)
  returning id into wine_id;

  return wine_id;
end;
$$;

revoke all on function public.find_or_create_wine(uuid, text, text, int, text, text, text, int) from public;
grant execute on function public.find_or_create_wine(uuid, text, text, int, text, text, text, int) to authenticated;

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

  return wine_ids;
end;
$$;

revoke all on function public.find_or_create_wines_batch(uuid, jsonb) from public;
grant execute on function public.find_or_create_wines_batch(uuid, jsonb) to authenticated;

create or replace function public.match_lwin_batch(p_wine_ids uuid[])
returns table (wine_id uuid, lwin_id text, score float)
language plpgsql security invoker set search_path = public
as $$
declare
  w record;
  m record;
begin
  for w in
    select id, producer, name, country, region, varietal
    from public.wines
    where id = any(p_wine_ids) and wines.lwin_id is null
  loop
    select * into m from public.match_lwin(w.producer, w.name);
    if m.lwin_id is not null then
      update public.wines set
        lwin_id  = m.lwin_id,
        country  = coalesce(wines.country, m.country),
        region   = coalesce(wines.region, m.region),
        varietal = coalesce(wines.varietal, m.varietal)
      where id = w.id;

      wine_id := w.id;
      lwin_id := m.lwin_id;
      score   := m.score;
      return next;
    end if;
  end loop;
end;
$$;

revoke all on function public.match_lwin_batch(uuid[]) from public;
grant execute on function public.match_lwin_batch(uuid[]) to authenticated;
