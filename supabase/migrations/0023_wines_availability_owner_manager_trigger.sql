-- DEBT-023: close the staff-bypass on the BND-037 wine availability columns.
--
-- Migration 0015 added three columns to `wines`:
--   is_eightysixed  boolean
--   eightysixed_at  timestamptz
--   eightysixed_by  uuid
--
-- and tried to protect them with a column-level
-- `REVOKE UPDATE (col) ON public.wines FROM authenticated`. Per the
-- note in migration 0022 (INT-019): column-level REVOKE is a no-op
-- when the original grant was table-level (Supabase bootstraps
-- `GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated`). The
-- REVOKE only subtracts from matching column-level grants; with none
-- to subtract from, the table-level grant wins. Confirmed empirically
-- against this DB — `has_column_privilege('authenticated',
-- 'public.wines', 'is_eightysixed', 'UPDATE')` still returns true
-- after 0015. So today migration 0015 is enforced only by the
-- `set_wine_availability` RPC being the app's only sane write path
-- plus the `members can update their wines` RLS policy — but any
-- staff-role member who calls Supabase directly with their token can
-- UPDATE these columns and bypass audit logging.
--
-- Enforcement: BEFORE UPDATE trigger, mirroring 0022.
--
-- DIFFERENCE vs 0022: the legitimate write path
-- (`set_wine_availability` RPC + `/api/wines/[id]/availability`)
-- admits BOTH `owner` AND `manager`. So the gate here is
-- `is_member_with_role(..., 'owner') OR is_member_with_role(..., 'manager')`.
-- Auto-86 on restaurants (0022) is owner-only; manual 86/restore on
-- wines is owner-or-manager.
--
-- NOTE on the RPC write path: `set_wine_availability` is
-- SECURITY DEFINER, so inside it current_user='postgres'. This trigger
-- short-circuits on the `current_user NOT IN ('authenticated','anon')`
-- guard, so the RPC continues to write the three columns normally.
-- The trigger ONLY blocks direct-UPDATE bypass via the Supabase client.

create or replace function public.enforce_owner_or_manager_for_wine_availability_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- No-op unless the availability columns are actually changing. Staff
  -- updating `name` / `producer` / etc. (legitimate flows permitted by
  -- the wines RLS UPDATE policy) pass through cleanly.
  if new.is_eightysixed is not distinct from old.is_eightysixed
     and new.eightysixed_at is not distinct from old.eightysixed_at
     and new.eightysixed_by is not distinct from old.eightysixed_by then
    return new;
  end if;

  -- postgres / service_role / other superuser contexts bypass. These
  -- are backend/cron/admin paths we trust, including the
  -- `set_wine_availability` SECURITY DEFINER RPC which runs as
  -- `postgres`. Only app callers (roles `authenticated` and `anon`)
  -- must satisfy the owner-or-manager check.
  --
  -- NOTE: this function is deliberately NOT SECURITY DEFINER — we
  -- need current_user to reflect the real caller. A SECURITY DEFINER
  -- trigger function would always see current_user='postgres' and
  -- would bypass the check entirely.
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  -- `new.restaurant_id` because wines.id is the wine UUID; membership
  -- is checked against the wine's restaurant.
  if not (public.is_member_with_role(new.restaurant_id, 'owner'::public.membership_role)
          or public.is_member_with_role(new.restaurant_id, 'manager'::public.membership_role)) then
    raise exception 'owner or manager role required to modify wine availability'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists wines_enforce_owner_manager_for_availability on public.wines;
create trigger wines_enforce_owner_manager_for_availability
  before update on public.wines
  for each row
  execute function public.enforce_owner_or_manager_for_wine_availability_update();

comment on function public.enforce_owner_or_manager_for_wine_availability_update() is
  'DEBT-023: BEFORE UPDATE enforcement for the BND-037 wine availability columns on wines. Raises 42501 when anyone who is not a restaurant owner or manager tries to change is_eightysixed / eightysixed_at / eightysixed_by via role `authenticated`/`anon`. No-op when the columns are unchanged. Superuser bypass (postgres/service_role) preserves the `set_wine_availability` SECURITY DEFINER RPC write path. Replaces the misleading column-level REVOKE in migration 0015 (Postgres no-op when bootstrap grant is table-level).';
