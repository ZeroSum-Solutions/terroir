begin;

select plan(6);

select ok(
  not exists (
    select 1
    from pg_tables
    where schemaname = 'public'
      and not has_table_privilege(
        'service_role',
        format('%I.%I', schemaname, tablename),
        'select,insert,update,delete'
      )
  ),
  'service_role has CRUD privileges on every public table'
);

select ok(
  not exists (
    select 1
    from pg_tables
    where schemaname = 'public'
      and not has_table_privilege(
        'authenticated',
        format('%I.%I', schemaname, tablename),
        'select,insert,update,delete'
      )
  ),
  'authenticated has table CRUD privileges mediated by RLS'
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
