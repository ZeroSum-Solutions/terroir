-- P2 wine identity spine — RLS/grants contract test, following
-- 0074_public_api_grants.sql's convention (plan/ok/finish, wrapped in a
-- rolled-back transaction so nothing persists).
begin;

select plan(14);

-- RLS enabled on every new table.
select ok(
  (select rowsecurity from pg_tables where schemaname = 'public' and tablename = 'canonical_wines'),
  'canonical_wines has row-level security enabled'
);
select ok(
  (select rowsecurity from pg_tables where schemaname = 'public' and tablename = 'wine_variants'),
  'wine_variants has row-level security enabled'
);
select ok(
  (select rowsecurity from pg_tables where schemaname = 'public' and tablename = 'wine_aliases'),
  'wine_aliases has row-level security enabled'
);
select ok(
  (select rowsecurity from pg_tables where schemaname = 'public' and tablename = 'identity_merge_log'),
  'identity_merge_log has row-level security enabled'
);

-- canonical_wines: authenticated select+insert, no update/delete.
--
-- P2 ROUND-2 FIX (D4): since canonical_wines' SELECT grant is now
-- column-level (excludes created_by_restaurant_id/created_by_user_id —
-- see 0097's migration comment), has_table_privilege(..., 'select')
-- correctly returns false here — table-level and column-level
-- privileges are NOT interchangeable in Postgres (verified live: a
-- column-level REVOKE layered on top of a table-level GRANT does NOT
-- restrict access, so the only way to actually hide a column is to never
-- grant table-level SELECT at all). Check a representative real column
-- instead of the table-level privilege.
select ok(
  has_column_privilege('authenticated', 'public.canonical_wines', 'producer_norm', 'select')
    and has_table_privilege('authenticated', 'public.canonical_wines', 'insert'),
  'authenticated can select (non-audit columns) and insert canonical_wines'
);
select ok(
  not has_table_privilege('authenticated', 'public.canonical_wines', 'update')
    and not has_table_privilege('authenticated', 'public.canonical_wines', 'delete'),
  'authenticated has no update/delete on canonical_wines — mutation is function-only'
);

-- D4 (round-2 critic finding): created_by_restaurant_id/created_by_user_id
-- are audit-only and must not be readable platform-wide by every
-- authenticated tenant — column-level grant, not a second RLS policy
-- (RLS is row-level only).
select ok(
  not has_column_privilege('authenticated', 'public.canonical_wines', 'created_by_restaurant_id', 'select'),
  'authenticated cannot read canonical_wines.created_by_restaurant_id (D4 fix)'
);
select ok(
  not has_column_privilege('authenticated', 'public.canonical_wines', 'created_by_user_id', 'select'),
  'authenticated cannot read canonical_wines.created_by_user_id (D4 fix)'
);

-- wine_variants: authenticated select+insert+update, no delete.
select ok(
  has_table_privilege('authenticated', 'public.wine_variants', 'select')
    and has_table_privilege('authenticated', 'public.wine_variants', 'insert')
    and has_table_privilege('authenticated', 'public.wine_variants', 'update'),
  'authenticated can select/insert/update wine_variants'
);
select ok(
  not has_table_privilege('authenticated', 'public.wine_variants', 'delete'),
  'authenticated has no delete on wine_variants — identity records are permanent'
);

-- identity_merge_log: authenticated select-only.
select ok(
  has_table_privilege('authenticated', 'public.identity_merge_log', 'select')
    and not has_table_privilege('authenticated', 'public.identity_merge_log', 'insert')
    and not has_table_privilege('authenticated', 'public.identity_merge_log', 'update')
    and not has_table_privilege('authenticated', 'public.identity_merge_log', 'delete'),
  'authenticated can read but never write identity_merge_log'
);

-- resolve_wine_variants_bulk: SECURITY INVOKER (C01's fix sketch applied to
-- new code — the load-bearing tenancy decision) and authenticated-callable.
select ok(
  not (select prosecdef from pg_proc where pronamespace = 'public'::regnamespace and proname = 'resolve_wine_variants_bulk'),
  'resolve_wine_variants_bulk is SECURITY INVOKER, not DEFINER'
);
select ok(
  has_function_privilege('authenticated', 'public.resolve_wine_variants_bulk(uuid, jsonb)', 'execute'),
  'authenticated can execute resolve_wine_variants_bulk'
);

-- merge_canonical_wines: NOT exposed to tenants — operator/service-role
-- only, per the orchestrating session's narrowing of the plan's original
-- (least-settled, per plan §14) stakeholder-manager authorization design.
select ok(
  not has_function_privilege('authenticated', 'public.merge_canonical_wines(uuid, uuid)', 'execute')
    and has_function_privilege('service_role', 'public.merge_canonical_wines(uuid, uuid)', 'execute'),
  'merge_canonical_wines is callable by service_role only, never authenticated'
);

select * from finish();

rollback;
