-- Focused acceptance test for 0054_tenant_rpc_hardening.sql.
-- Run against an isolated, migrated Supabase database:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f supabase/tests/0054_tenant_rpc_hardening.sql

begin;

create or replace function pg_temp.expect_constraint(
  p_sql text,
  p_sqlstate text,
  p_constraint text default null,
  p_message text default null
) returns void
language plpgsql
as $$
declare
  v_sqlstate text;
  v_constraint text;
  v_message text;
begin
  begin
    execute p_sql;
    raise exception using
      errcode = 'XX000',
      message = 'expected statement to fail: ' || p_sql;
  exception when others then
    get stacked diagnostics
      v_sqlstate = returned_sqlstate,
      v_constraint = constraint_name,
      v_message = message_text;

    if v_sqlstate <> p_sqlstate
       or (
         p_constraint is not null
         and v_constraint is distinct from p_constraint
       )
       or (
         p_message is not null
         and v_message is distinct from p_message
       ) then
      raise exception
        'unexpected failure: state=%, constraint=%, message=%',
        v_sqlstate,
        v_constraint,
        v_message;
    end if;
  end;
end;
$$;

insert into auth.users (
  id,
  email,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
) values (
  '10000000-0000-4000-8000-000000000001',
  'tenant-hardening@example.test',
  '{}'::jsonb,
  '{"restaurant_name":"Acceptance Default"}'::jsonb,
  now(),
  now()
), (
  '10000000-0000-4000-8000-000000000002',
  'tenant-manager@example.test',
  '{}'::jsonb,
  '{"restaurant_name":"Manager Default"}'::jsonb,
  now(),
  now()
), (
  '10000000-0000-4000-8000-000000000003',
  'tenant-staff@example.test',
  '{}'::jsonb,
  '{"restaurant_name":"Staff Default"}'::jsonb,
  now(),
  now()
);

insert into public.restaurants (id, name) values
  ('20000000-0000-4000-8000-000000000001', 'Restaurant A'),
  ('20000000-0000-4000-8000-000000000002', 'Restaurant B'),
  ('20000000-0000-4000-8000-000000000003', 'Restaurant C');

insert into public.memberships (user_id, restaurant_id, role) values
  (
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    'owner'
  ),
  (
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002',
    'owner'
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000001',
    'manager'
  ),
  (
    '10000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000001',
    'staff'
  );

grant select, insert, update, delete on public.invitations to authenticated;

insert into public.invitations (
  id,
  restaurant_id,
  email,
  role,
  invited_by
) values (
  '90000000-0000-4000-8000-000000000003',
  '20000000-0000-4000-8000-000000000001',
  'staff-cannot-manage@example.test',
  'staff',
  '10000000-0000-4000-8000-000000000001'
);

insert into public.wines (
  id,
  restaurant_id,
  name,
  producer,
  size_ml
) values
  (
    '30000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    'A Wine',
    'A Producer',
    750
  ),
  (
    '30000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000002',
    'B Wine',
    'B Producer',
    750
  );

insert into public.invoice_scans (
  id,
  restaurant_id,
  distributor_name,
  parsed_line_items,
  final_line_items
) values (
  '40000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000002',
  'B Distributor',
  '[]'::jsonb,
  '[]'::jsonb
);

insert into public.inventory_items (
  id,
  wine_id,
  restaurant_id,
  quantity,
  unit_cost
) values
  (
    '50000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    2,
    10
  ),
  (
    '50000000-0000-4000-8000-000000000002',
    '30000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000002',
    2,
    10
  );

insert into public.wine_lists (id, restaurant_id, name) values (
  '60000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  'A List'
), (
  '60000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000002',
  'B List'
);

insert into public.wine_list_sections (id, wine_list_id, name) values (
  '70000000-0000-4000-8000-000000000001',
  '60000000-0000-4000-8000-000000000001',
  'A Section'
);

-- Direct relational writes cannot forge cross-tenant parentage.
select pg_temp.expect_constraint(
  $sql$
    insert into public.inventory_items (
      wine_id, restaurant_id, quantity, unit_cost
    ) values (
      '30000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000001',
      1,
      10
    )
  $sql$,
  '23503',
  'inventory_items_wine_tenant_fkey'
);

select pg_temp.expect_constraint(
  $sql$
    insert into public.inventory_items (
      wine_id, restaurant_id, invoice_scan_id, quantity, unit_cost
    ) values (
      '30000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000002',
      1,
      10
    )
  $sql$,
  '23503',
  'inventory_items_scan_tenant_fkey'
);

select pg_temp.expect_constraint(
  $sql$
    insert into public.availability_events (
      wine_id, restaurant_id, direction
    ) values (
      '30000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000001',
      'restored'
    )
  $sql$,
  '23503',
  'availability_events_wine_tenant_fkey'
);

select pg_temp.expect_constraint(
  $sql$
    insert into public.open_bottles (
      wine_id, restaurant_id, remaining_ml
    ) values (
      '30000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000001',
      500
    )
  $sql$,
  '23503',
  'open_bottles_wine_tenant_fkey'
);

select pg_temp.expect_constraint(
  $sql$
    insert into public.open_bottles (
      wine_id,
      restaurant_id,
      remaining_ml,
      source_inventory_item_id
    ) values (
      '30000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      500,
      '50000000-0000-4000-8000-000000000002'
    )
    on conflict (wine_id, restaurant_id)
    do update set source_inventory_item_id = excluded.source_inventory_item_id
  $sql$,
  '23503',
  'open_bottles_source_inventory_tenant_fkey'
);

select pg_temp.expect_constraint(
  $sql$
    insert into public.pour_events (
      wine_id, restaurant_id, ml_delta, kind
    ) values (
      '30000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000001',
      30,
      'pour'
    )
  $sql$,
  '23503',
  'pour_events_wine_tenant_fkey'
);

insert into public.open_bottles (
  id,
  wine_id,
  restaurant_id,
  remaining_ml,
  source_inventory_item_id
) values (
  '80000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000002',
  500,
  '50000000-0000-4000-8000-000000000002'
);

select pg_temp.expect_constraint(
  $sql$
    insert into public.pour_events (
      wine_id,
      restaurant_id,
      ml_delta,
      kind,
      open_bottle_id
    ) values (
      '30000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      30,
      'pour',
      '80000000-0000-4000-8000-000000000002'
    )
  $sql$,
  '23503',
  'pour_events_open_bottle_tenant_fkey'
);

select pg_temp.expect_constraint(
  $sql$
    insert into public.wine_list_items (
      section_id, wine_id
    ) values (
      '70000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000002'
    )
  $sql$,
  '23514',
  null,
  'wine_list_item_tenant_mismatch'
);

select pg_temp.expect_constraint(
  $sql$
    update public.wines
    set restaurant_id = '20000000-0000-4000-8000-000000000002'
    where id = '30000000-0000-4000-8000-000000000001'
  $sql$,
  '23514',
  null,
  'wines.restaurant_id is immutable'
);

select pg_temp.expect_constraint(
  $sql$
    update public.wine_list_sections
    set wine_list_id = '60000000-0000-4000-8000-000000000002'
    where id = '70000000-0000-4000-8000-000000000001'
  $sql$,
  '23514',
  null,
  'wine_list_sections.wine_list_id is immutable'
);

-- Managers own the full invitation lifecycle.
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000002',
  true
);
set local role authenticated;

do $$
declare
  v_count int;
begin
  insert into public.invitations (
    id,
    restaurant_id,
    email,
    role,
    invited_by
  ) values (
    '90000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000001',
    'manager-created@example.test',
    'staff',
    '10000000-0000-4000-8000-000000000002'
  );

  select count(*) into v_count
  from public.invitations
  where id = '90000000-0000-4000-8000-000000000002';
  if v_count <> 1 then
    raise exception 'manager could not read its restaurant invitation';
  end if;

  update public.invitations
  set expires_at = expires_at + interval '1 day'
  where id = '90000000-0000-4000-8000-000000000002';
  get diagnostics v_count = row_count;
  if v_count <> 1 then
    raise exception 'manager could not resend its restaurant invitation';
  end if;

  delete from public.invitations
  where id = '90000000-0000-4000-8000-000000000002';
  get diagnostics v_count = row_count;
  if v_count <> 1 then
    raise exception 'manager could not revoke its restaurant invitation';
  end if;
end;
$$;

reset role;

-- Staff cannot create, read, resend, or revoke invitations.
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000003',
  true
);
set local role authenticated;

select pg_temp.expect_constraint(
  $sql$
    insert into public.invitations (
      restaurant_id,
      email,
      role,
      invited_by
    ) values (
      '20000000-0000-4000-8000-000000000001',
      'staff-created@example.test',
      'staff',
      '10000000-0000-4000-8000-000000000003'
    )
  $sql$,
  '42501'
);

do $$
declare
  v_count int;
begin
  select count(*) into v_count
  from public.invitations
  where id = '90000000-0000-4000-8000-000000000003';
  if v_count <> 0 then
    raise exception 'staff could read an invitation';
  end if;

  update public.invitations
  set expires_at = expires_at + interval '1 day'
  where id = '90000000-0000-4000-8000-000000000003';
  get diagnostics v_count = row_count;
  if v_count <> 0 then
    raise exception 'staff could resend an invitation';
  end if;

  delete from public.invitations
  where id = '90000000-0000-4000-8000-000000000003';
  get diagnostics v_count = row_count;
  if v_count <> 0 then
    raise exception 'staff could revoke an invitation';
  end if;
end;
$$;

reset role;

-- Simulate an authenticated multi-restaurant user. The explicit restaurant
-- argument, not membership in any other tenant, scopes each mutation.
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;

select pg_temp.expect_constraint(
  $sql$
    select public.record_pour(
      '20000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000002',
      30,
      'pour',
      null
    )
  $sql$,
  'P0001',
  null,
  'wine not found'
);

select pg_temp.expect_constraint(
  $sql$
    select public.undo_last_pour(
      '20000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000002'
    )
  $sql$,
  'P0001',
  null,
  'wine not found'
);

select pg_temp.expect_constraint(
  $sql$
    select public.reconcile_open_bottle(
      '20000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000002',
      400,
      null
    )
  $sql$,
  'P0001',
  null,
  'wine not found'
);

select pg_temp.expect_constraint(
  $sql$
    select public.reconcile_open_bottles_batch(
      '20000000-0000-4000-8000-000000000001',
      '[{
        "wine_id":"30000000-0000-4000-8000-000000000002",
        "new_remaining_ml":400
      }]'::jsonb
    )
  $sql$,
  'P0001',
  null,
  'wine not found'
);

select pg_temp.expect_constraint(
  $sql$
    select public.match_lwin_batch(
      '20000000-0000-4000-8000-000000000001',
      array['30000000-0000-4000-8000-000000000002']::uuid[]
    )
  $sql$,
  'P0001',
  null,
  'wine not found'
);

select pg_temp.expect_constraint(
  $sql$
    select public.find_or_create_wine(
      '20000000-0000-4000-8000-000000000003',
      'Forbidden Wine',
      'Forbidden Producer'
    )
  $sql$,
  '42501',
  null,
  'forbidden'
);

do $$
declare
  v_bottle public.open_bottles%rowtype;
  v_created_wine_id uuid;
begin
  select * into v_bottle
  from public.record_pour(
    '20000000-0000-4000-8000-000000000002',
    '30000000-0000-4000-8000-000000000002',
    30,
    'pour',
    null
  );

  if v_bottle.restaurant_id <>
       '20000000-0000-4000-8000-000000000002'::uuid
     or v_bottle.wine_id <>
       '30000000-0000-4000-8000-000000000002'::uuid
     or v_bottle.remaining_ml <> 470 then
    raise exception 'record_pour did not stay inside restaurant B';
  end if;

  v_created_wine_id := public.find_or_create_wine(
    '20000000-0000-4000-8000-000000000001',
    'Created Wine',
    'Created Producer'
  );

  if v_created_wine_id is null
     or public.find_or_create_wine(
       '20000000-0000-4000-8000-000000000001',
       'Created Wine',
       'Created Producer'
     ) <> v_created_wine_id then
    raise exception 'find_or_create_wine escaped restaurant A';
  end if;
end;
$$;

reset role;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.record_pour(uuid,uuid,integer,text,text)',
    'public.undo_last_pour(uuid,uuid)',
    'public.reconcile_open_bottle(uuid,uuid,integer,text)',
    'public.reconcile_open_bottles_batch(uuid,jsonb)',
    'public.find_or_create_wine(uuid,text,text,integer,text,text,text,integer)',
    'public.find_or_create_wines_batch(uuid,jsonb)',
    'public.match_lwin_batch(uuid,uuid[])',
    'public.list_open_bottle_items(uuid)',
    'public.wine_published_list_slugs(uuid,uuid)'
  ]
  loop
    if has_function_privilege('anon', v_signature, 'EXECUTE') then
      raise exception 'anon retains execute on %', v_signature;
    end if;
    if not has_function_privilege('authenticated', v_signature, 'EXECUTE') then
      raise exception 'authenticated lacks execute on %', v_signature;
    end if;
  end loop;

  if to_regprocedure('public.record_pour(uuid,integer,text,text)') is not null
     or to_regprocedure('public.undo_last_pour(uuid)') is not null
     or to_regprocedure(
       'public.reconcile_open_bottle(uuid,integer,text)'
     ) is not null
     or to_regprocedure(
       'public.reconcile_open_bottles_batch(jsonb)'
     ) is not null
     or to_regprocedure('public.match_lwin_batch(uuid[])') is not null then
    raise exception 'a tenant-implicit RPC overload still exists';
  end if;

  if exists (
    select 1
    from pg_proc
    where oid in (
      to_regprocedure('public.list_open_bottle_items(uuid)'),
      to_regprocedure('public.wine_published_list_slugs(uuid,uuid)')
    )
      and not (
        coalesce(proconfig, '{}'::text[])
        @> array['search_path=""']::text[]
      )
  ) then
    raise exception 'a hardened read RPC retains a writable search path';
  end if;
end;
$$;

rollback;

select '0054 tenant RPC hardening acceptance passed' as result;
