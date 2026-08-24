begin;

select plan(7);

-- C30 (db audit 2026-08-23): has_table_privilege('role', 'table',
-- 'select,insert,update,delete') uses Postgres's documented "ANY of the
-- listed privileges" semantics for a comma-separated privilege list, not
-- "ALL of them" — so a role missing insert/update/delete but retaining
-- select still reads as true. These two assertions exist to assert
-- CRUD-complete access; each privilege is now checked (and ANDed)
-- separately so a partial-grant regression (e.g. an accidental REVOKE)
-- actually fails the test instead of passing on SELECT alone. The other
-- two comma-list uses below (anon must have select on five tables; anon
-- must have NONE of insert/update/delete) are unaffected: "has select" is
-- a single privilege already, and "must-have-none-of" is correctly an
-- any-of check (any one of the three being grantable is already a fail).

select ok(
  not exists (
    select 1
    from pg_tables
    where schemaname = 'public'
      and not (
        has_table_privilege('service_role', format('%I.%I', schemaname, tablename), 'select')
        and has_table_privilege('service_role', format('%I.%I', schemaname, tablename), 'insert')
        and has_table_privilege('service_role', format('%I.%I', schemaname, tablename), 'update')
        and has_table_privilege('service_role', format('%I.%I', schemaname, tablename), 'delete')
      )
  ),
  'service_role has CRUD privileges on every public table'
);

-- Three tables are deliberately excluded from the blanket CRUD check
-- below because their access model intentionally moved off raw grants:
--   - background_jobs (0083, C20 fix): authenticated write access goes
--     only through enqueue_invoice_extract_job (SECURITY DEFINER);
--     INSERT/UPDATE/DELETE are revoked from authenticated outright.
--   - import_batches / import_batch_rows (0076): authenticated has no
--     direct DELETE — rows are removed only via revert_import_batch, a
--     RLS-scoped RPC, never a raw client-side delete.
-- The next assertion pins exactly what these three DO still have, so a
-- further regression (e.g. SELECT itself getting revoked) is still caught.
select ok(
  not exists (
    select 1
    from pg_tables
    where schemaname = 'public'
      and tablename not in ('background_jobs', 'import_batches', 'import_batch_rows')
      and not (
        has_table_privilege('authenticated', format('%I.%I', schemaname, tablename), 'select')
        and has_table_privilege('authenticated', format('%I.%I', schemaname, tablename), 'insert')
        and has_table_privilege('authenticated', format('%I.%I', schemaname, tablename), 'update')
        and has_table_privilege('authenticated', format('%I.%I', schemaname, tablename), 'delete')
      )
  ),
  'authenticated has table CRUD privileges mediated by RLS (except tables deliberately gated behind a SECURITY DEFINER/INVOKER RPC instead of direct grants)'
);

select ok(
  has_table_privilege('authenticated', 'public.background_jobs', 'select')
    and not has_table_privilege('authenticated', 'public.background_jobs', 'insert')
    and not has_table_privilege('authenticated', 'public.background_jobs', 'update')
    and not has_table_privilege('authenticated', 'public.background_jobs', 'delete')
    and has_table_privilege('authenticated', 'public.import_batches', 'select')
    and has_table_privilege('authenticated', 'public.import_batches', 'insert')
    and has_table_privilege('authenticated', 'public.import_batches', 'update')
    and not has_table_privilege('authenticated', 'public.import_batches', 'delete')
    and has_table_privilege('authenticated', 'public.import_batch_rows', 'select')
    and has_table_privilege('authenticated', 'public.import_batch_rows', 'insert')
    and has_table_privilege('authenticated', 'public.import_batch_rows', 'update')
    and not has_table_privilege('authenticated', 'public.import_batch_rows', 'delete'),
  'the three RPC-gated tables have exactly their intended reduced grants, not more and not less'
);

select ok(
  not exists (
    select 1
    from pg_tables
    where schemaname = 'public'
      and not rowsecurity
  ),
  'every public table has row-level security enabled'
);

select ok(
  has_table_privilege('anon', 'public.restaurants', 'select')
    and has_table_privilege('anon', 'public.wine_lists', 'select')
    and has_table_privilege('anon', 'public.wine_list_sections', 'select')
    and has_table_privilege('anon', 'public.wine_list_items', 'select')
    and has_table_privilege('anon', 'public.wines', 'select'),
  'anon can read only the published-menu table graph through RLS'
);

select ok(
  not exists (
    select 1
    from pg_tables
    where schemaname = 'public'
      and has_table_privilege(
        'anon',
        format('%I.%I', schemaname, tablename),
        'insert,update,delete'
      )
  ),
  'anon has no public-table write privileges'
);

select ok(
  (
    select count(distinct privilege_type) = 4
    from pg_default_acl d
    cross join lateral aclexplode(d.defaclacl) acl
    where d.defaclrole = 'postgres'::regrole
      and d.defaclnamespace = 'public'::regnamespace
      and d.defaclobjtype = 'r'
      and acl.grantee = 'service_role'::regrole
      and acl.privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
  ),
  'future postgres-owned public tables grant service_role CRUD by default'
);

select * from finish();

rollback;
