-- Focused acceptance for 0064_create_wine_list_item_idempotency.sql.
-- Run against an isolated database with migrations through 0064 applied.

begin;

create or replace function pg_temp.expect_failure(
  p_sql text,
  p_sqlstate text
) returns void
language plpgsql
as $$
declare
  v_sqlstate text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_sqlstate = returned_sqlstate;
    if v_sqlstate <> p_sqlstate then
      raise exception
        'expected SQLSTATE %, received % for %',
        p_sqlstate,
        v_sqlstate,
        p_sql;
    end if;
    return;
  end;
  raise exception 'expected statement to fail: %', p_sql;
end;
$$;

insert into auth.users (
  id,
  email,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
) values
  (
    '64000000-0000-4000-8000-000000000001',
    'manager-0064@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '64000000-0000-4000-8000-000000000002',
    'staff-0064@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '64000000-0000-4000-8000-000000000003',
    'outsider-0064@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

insert into public.restaurants (id, name) values
  (
    '64100000-0000-4000-8000-000000000001',
    'Atomic Item Restaurant'
  ),
  (
    '64100000-0000-4000-8000-000000000002',
    'Other Item Restaurant'
  );

insert into public.memberships (user_id, restaurant_id, role) values
  (
    '64000000-0000-4000-8000-000000000001',
    '64100000-0000-4000-8000-000000000001',
    'manager'
  ),
  (
    '64000000-0000-4000-8000-000000000002',
    '64100000-0000-4000-8000-000000000001',
    'staff'
  );

insert into public.wine_lists (
  id,
  restaurant_id,
  name
) values
  (
    '64200000-0000-4000-8000-000000000001',
    '64100000-0000-4000-8000-000000000001',
    'Dinner'
  ),
  (
    '64200000-0000-4000-8000-000000000002',
    '64100000-0000-4000-8000-000000000002',
    'Other Dinner'
  );

insert into public.wine_list_sections (
  id,
  wine_list_id,
  name,
  position
) values
  (
    '64300000-0000-4000-8000-000000000001',
    '64200000-0000-4000-8000-000000000001',
    'By the Glass',
    0
  ),
  (
    '64300000-0000-4000-8000-000000000002',
    '64200000-0000-4000-8000-000000000002',
    'Other',
    0
  );

insert into public.wines (
  id,
  restaurant_id,
  name,
  producer
) values
  (
    '64400000-0000-4000-8000-000000000001',
    '64100000-0000-4000-8000-000000000001',
    'Replay Wine',
    '0064 Producer'
  ),
  (
    '64400000-0000-4000-8000-000000000002',
    '64100000-0000-4000-8000-000000000001',
    'Rollback Wine',
    '0064 Producer'
  ),
  (
    '64400000-0000-4000-8000-000000000003',
    '64100000-0000-4000-8000-000000000002',
    'Other Wine',
    '0064 Producer'
  );

insert into public.wine_list_items (
  id,
  section_id,
  wine_id,
  position
) values (
  '64500000-0000-4000-8000-000000000001',
  '64300000-0000-4000-8000-000000000002',
  '64400000-0000-4000-8000-000000000003',
  0
);

do $$
begin
  if has_function_privilege(
    'anon',
    'public.create_wine_list_item_idempotent(uuid,uuid,uuid,numeric,numeric,text,text,text)',
    'EXECUTE'
  ) then
    raise exception 'anon retains atomic item-create execution';
  end if;
  if not has_function_privilege(
    'authenticated',
    'public.create_wine_list_item_idempotent(uuid,uuid,uuid,numeric,numeric,text,text,text)',
    'EXECUTE'
  ) then
    raise exception 'authenticated lacks atomic item-create execution';
  end if;
end;
$$;

-- Staff and outsiders cannot cross the manager-only boundary.
select set_config(
  'request.jwt.claim.sub',
  '64000000-0000-4000-8000-000000000002',
  true
);
set local role authenticated;
select pg_temp.expect_failure(
  $sql$
    select * from public.create_wine_list_item_idempotent(
      '64100000-0000-4000-8000-000000000001',
      '64300000-0000-4000-8000-000000000001',
      '64400000-0000-4000-8000-000000000001'
    )
  $sql$,
  '42501'
);
reset role;

select set_config(
  'request.jwt.claim.sub',
  '64000000-0000-4000-8000-000000000003',
  true
);
set local role authenticated;
select pg_temp.expect_failure(
  $sql$
    select * from public.create_wine_list_item_idempotent(
      '64100000-0000-4000-8000-000000000001',
      '64300000-0000-4000-8000-000000000001',
      '64400000-0000-4000-8000-000000000001'
    )
  $sql$,
  '42501'
);
reset role;

-- Missing keys preserve the legacy mutation without creating a claim.
select set_config(
  'request.jwt.claim.sub',
  '64000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;
do $$
declare
  v_result record;
begin
  select * into strict v_result
  from public.create_wine_list_item_idempotent(
    '64100000-0000-4000-8000-000000000001',
    '64300000-0000-4000-8000-000000000001',
    '64400000-0000-4000-8000-000000000001',
    14,
    48,
    null
  );
  if v_result.outcome <> 'created'
     or v_result.response_status <> 200
     or v_result.response_body #>> '{id}' is null
     or v_result.replayed then
    raise exception 'unkeyed response malformed: %',
      row_to_json(v_result);
  end if;
end;
$$;
reset role;

do $$
begin
  if (
    select count(*)
    from public.api_idempotency
    where user_id = '64000000-0000-4000-8000-000000000001'
  ) <> 0 then
    raise exception 'unkeyed create leaked an idempotency claim';
  end if;
end;
$$;

-- A keyed call and its replay return the exact same id and only one row.
select set_config(
  'request.jwt.claim.sub',
  '64000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;
do $$
declare
  v_fresh record;
  v_replay record;
begin
  select * into strict v_fresh
  from public.create_wine_list_item_idempotent(
    '64100000-0000-4000-8000-000000000001',
    '64300000-0000-4000-8000-000000000001',
    '64400000-0000-4000-8000-000000000001',
    18,
    64,
    'Reserve',
    'item_replay_key_0064',
    repeat('a', 64)
  );
  select * into strict v_replay
  from public.create_wine_list_item_idempotent(
    '64100000-0000-4000-8000-000000000001',
    '64300000-0000-4000-8000-000000000001',
    '64400000-0000-4000-8000-000000000001',
    18,
    64,
    'Reserve',
    'item_replay_key_0064',
    repeat('a', 64)
  );
  if v_fresh.outcome <> 'created'
     or v_fresh.replayed
     or v_replay.outcome <> 'replay'
     or not v_replay.replayed
     or v_replay.response_body <> v_fresh.response_body then
    raise exception 'fresh/replay mismatch: fresh=%, replay=%',
      row_to_json(v_fresh),
      row_to_json(v_replay);
  end if;
end;
$$;
reset role;

do $$
begin
  if (
    select count(*)
    from public.wine_list_items
    where section_id = '64300000-0000-4000-8000-000000000001'
      and wine_id = '64400000-0000-4000-8000-000000000001'
  ) <> 2 then
    raise exception 'replay duplicated the keyed item';
  end if;
  if (
    select array_agg(position order by position)
    from public.wine_list_items
    where section_id = '64300000-0000-4000-8000-000000000001'
  ) <> array[0, 1] then
    raise exception 'item positions are not contiguous';
  end if;
end;
$$;

-- Reorder is one convergent update: repeating the same order is harmless, and
-- a mixed-section failure rolls the whole statement back.
select set_config(
  'request.jwt.claim.sub',
  '64000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;
do $$
declare
  v_ids uuid[];
  v_reversed uuid[];
begin
  select array_agg(id order by position)
  into strict v_ids
  from public.wine_list_items
  where section_id = '64300000-0000-4000-8000-000000000001';
  v_reversed := array[v_ids[2], v_ids[1]];

  perform public.reorder_wine_list_items(v_reversed);
  perform public.reorder_wine_list_items(v_reversed);

  if (
    select array_agg(id order by position)
    from public.wine_list_items
    where section_id = '64300000-0000-4000-8000-000000000001'
  ) <> v_reversed then
    raise exception 'repeated reorder did not converge';
  end if;

  perform pg_temp.expect_failure(
    format(
      'select public.reorder_wine_list_items(array[%L::uuid,%L::uuid])',
      v_ids[1],
      '64500000-0000-4000-8000-000000000001'
    ),
    'P0001'
  );

  if (
    select array_agg(id order by position)
    from public.wine_list_items
    where section_id = '64300000-0000-4000-8000-000000000001'
  ) <> v_reversed then
    raise exception 'failed mixed-section reorder changed positions';
  end if;
end;
$$;
reset role;

-- Tenant mismatches resolve opaquely and never insert cross-tenant data.
select set_config(
  'request.jwt.claim.sub',
  '64000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;
do $$
declare
  v_result record;
begin
  select * into strict v_result
  from public.create_wine_list_item_idempotent(
    '64100000-0000-4000-8000-000000000001',
    '64300000-0000-4000-8000-000000000002',
    '64400000-0000-4000-8000-000000000003',
    null,
    null,
    null,
    'item_tenant_key_0064',
    repeat('b', 64)
  );
  if v_result.outcome <> 'not_found'
     or v_result.response_status <> 404
     or v_result.response_body #>> '{error,code}' <> 'not_found' then
    raise exception 'tenant mismatch response malformed: %',
      row_to_json(v_result);
  end if;
end;
$$;
reset role;

-- If response completion fails, the item and newly inserted claim roll back.
create or replace function pg_temp.reject_item_completion_0064()
returns trigger
language plpgsql
as $$
begin
  raise exception using
    errcode = 'XX000',
    message = 'induced 0064 completion failure';
end;
$$;

create trigger reject_item_completion_0064
before update on public.api_idempotency
for each row
when (new.idempotency_key = 'item_rollback_key_0064')
execute function pg_temp.reject_item_completion_0064();

select set_config(
  'request.jwt.claim.sub',
  '64000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;
select pg_temp.expect_failure(
  $sql$
    select * from public.create_wine_list_item_idempotent(
      '64100000-0000-4000-8000-000000000001',
      '64300000-0000-4000-8000-000000000001',
      '64400000-0000-4000-8000-000000000002',
      null,
      72,
      null,
      'item_rollback_key_0064',
      repeat('c', 64)
    )
  $sql$,
  'XX000'
);
reset role;
drop trigger reject_item_completion_0064 on public.api_idempotency;

do $$
begin
  if exists (
    select 1
    from public.wine_list_items
    where wine_id = '64400000-0000-4000-8000-000000000002'
  ) then
    raise exception 'completion failure leaked its item insert';
  end if;
  if exists (
    select 1
    from public.api_idempotency
    where idempotency_key = 'item_rollback_key_0064'
  ) then
    raise exception 'completion failure leaked its claim';
  end if;
end;
$$;

select '0064 wine-list item idempotency acceptance passed' as result;

rollback;
