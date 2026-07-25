-- Focused acceptance for 0067_restaurant_lifecycle_idempotency.sql.
-- Run only against an isolated database with migrations through 0067:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f supabase/tests/0067_restaurant_lifecycle_idempotency.sql

create or replace function pg_temp.request_hash(p_restaurant_id uuid)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.encode(
    extensions.digest(
      pg_catalog.int8send(
        pg_catalog.octet_length(
          pg_catalog.convert_to(
            '{"id":' ||
            pg_catalog.to_json(p_restaurant_id::text)::text ||
            '}',
            'UTF8'
          )
        )::bigint
      ) ||
      pg_catalog.convert_to(
        '{"id":' ||
        pg_catalog.to_json(p_restaurant_id::text)::text ||
        '}',
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
$$;

drop trigger if exists reject_restaurant_delete_completion_0067
  on public.api_idempotency;
drop function if exists public.reject_restaurant_delete_completion_0067();

delete from public.restaurants
where id::text like '64100000-0000-4000-8000-00000000000%';
delete from auth.users
where id::text like '64000000-0000-4000-8000-00000000000%';

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
    'owner-0067@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '64000000-0000-4000-8000-000000000002',
    'staff-0067@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

insert into public.restaurants (id, name) values
  (
    '64100000-0000-4000-8000-000000000001',
    'Keyed Delete Restaurant'
  ),
  (
    '64100000-0000-4000-8000-000000000002',
    'Authorization Restaurant'
  ),
  (
    '64100000-0000-4000-8000-000000000003',
    'Rollback Restaurant'
  ),
  (
    '64100000-0000-4000-8000-000000000004',
    'Keyless Restaurant'
  );

insert into public.memberships (
  user_id,
  restaurant_id,
  role
) values
  (
    '64000000-0000-4000-8000-000000000001',
    '64100000-0000-4000-8000-000000000001',
    'owner'
  ),
  (
    '64000000-0000-4000-8000-000000000001',
    '64100000-0000-4000-8000-000000000003',
    'owner'
  ),
  (
    '64000000-0000-4000-8000-000000000001',
    '64100000-0000-4000-8000-000000000004',
    'owner'
  ),
  (
    '64000000-0000-4000-8000-000000000002',
    '64100000-0000-4000-8000-000000000002',
    'staff'
  );

do $$
begin
  if has_function_privilege(
    'anon',
    'public.delete_restaurant_idempotent(uuid,uuid,text,text)',
    'EXECUTE'
  ) then
    raise exception 'anon retains restaurant deletion execution';
  end if;
  if not has_function_privilege(
    'authenticated',
    'public.delete_restaurant_idempotent(uuid,uuid,text,text)',
    'EXECUTE'
  ) then
    raise exception 'authenticated lacks restaurant deletion execution';
  end if;
  if exists (
    select 1
    from pg_proc
    where oid = to_regprocedure(
      'public.delete_restaurant_idempotent(uuid,uuid,text,text)'
    )
      and (
        not prosecdef
        or not (
          coalesce(proconfig, '{}'::text[])
          @> array['search_path=""']::text[]
        )
      )
  ) then
    raise exception 'restaurant deletion RPC execution context is not hardened';
  end if;
  if exists (
    select 1
    from pg_constraint
    where conrelid = 'public.api_idempotency'::regclass
      and contype = 'f'
      and conname = 'api_idempotency_restaurant_id_fkey'
  ) then
    raise exception 'tenant-root delete would still cascade its replay record';
  end if;
end;
$$;

-- New commands preserve active-tenant and owner authorization.
select set_config(
  'request.jwt.claim.sub',
  '64000000-0000-4000-8000-000000000002',
  false
);
set role authenticated;
do $$
declare
  v_result record;
begin
  select * into v_result
  from public.delete_restaurant_idempotent(
    '64100000-0000-4000-8000-000000000002',
    '64100000-0000-4000-8000-000000000002'
  );
  if v_result.outcome <> 'owner_required'
     or v_result.response_status <> 403
     or v_result.response_body #>> '{error,message}'
          <> 'Owner access required.' then
    raise exception 'staff authorization response malformed: %',
      row_to_json(v_result);
  end if;
end;
$$;
reset role;

select set_config(
  'request.jwt.claim.sub',
  '64000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;
do $$
declare
  v_result record;
begin
  select * into v_result
  from public.delete_restaurant_idempotent(
    '64100000-0000-4000-8000-000000000001',
    '64100000-0000-4000-8000-000000000003'
  );
  if v_result.outcome <> 'forbidden'
     or v_result.response_status <> 403 then
    raise exception 'cross-active authorization response malformed: %',
      row_to_json(v_result);
  end if;
end;
$$;
reset role;

-- A false canonical hash fails before a claim or business mutation.
select set_config(
  'request.jwt.claim.sub',
  '64000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;
do $$
begin
  begin
    perform *
    from public.delete_restaurant_idempotent(
      '64100000-0000-4000-8000-000000000001',
      '64100000-0000-4000-8000-000000000001',
      'delete_false_hash_0067',
      repeat('a', 64)
    );
  exception when sqlstate '22023' then
    return;
  end;
  raise exception 'false deletion hash did not fail';
end;
$$;
reset role;

do $$
begin
  if not exists (
    select 1
    from public.restaurants
    where id = '64100000-0000-4000-8000-000000000001'
  ) or exists (
    select 1
    from public.api_idempotency
    where idempotency_key = 'delete_false_hash_0067'
  ) then
    raise exception 'false hash changed deletion state';
  end if;
end;
$$;

-- Keyless compatibility returns the legacy body and leaves no claim.
select set_config(
  'request.jwt.claim.sub',
  '64000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;
do $$
declare
  v_result record;
begin
  select * into v_result
  from public.delete_restaurant_idempotent(
    '64100000-0000-4000-8000-000000000004',
    '64100000-0000-4000-8000-000000000004'
  );
  if v_result.outcome <> 'deleted'
     or v_result.response_status <> 200
     or v_result.response_body <> '{"ok":true}'::jsonb
     or v_result.replayed then
    raise exception 'keyless delete response malformed: %',
      row_to_json(v_result);
  end if;
end;
$$;
reset role;

-- Keyed deletion stores its exact response outside the deleted tenant graph,
-- then replays even though the membership no longer exists.
select set_config(
  'request.jwt.claim.sub',
  '64000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;
do $$
declare
  v_hash text := pg_temp.request_hash(
    '64100000-0000-4000-8000-000000000001'
  );
  v_fresh record;
  v_replay record;
begin
  select * into v_fresh
  from public.delete_restaurant_idempotent(
    '64100000-0000-4000-8000-000000000001',
    '64100000-0000-4000-8000-000000000001',
    'delete_replay_key_0067',
    v_hash
  );
  select * into v_replay
  from public.delete_restaurant_idempotent(
    '64100000-0000-4000-8000-000000000001',
    null,
    'delete_replay_key_0067',
    v_hash
  );
  if v_fresh.outcome <> 'deleted'
     or v_fresh.response_status <> 200
     or v_fresh.response_body <> '{"ok":true}'::jsonb
     or v_fresh.replayed
     or v_replay.outcome <> 'replay'
     or v_replay.response_status <> v_fresh.response_status
     or v_replay.response_body <> v_fresh.response_body
     or not v_replay.replayed
     or v_replay.execution_started_at
          <> v_fresh.execution_started_at then
    raise exception 'delete replay malformed: fresh=%, replay=%',
      row_to_json(v_fresh),
      row_to_json(v_replay);
  end if;
end;
$$;
reset role;

do $$
begin
  if exists (
    select 1
    from public.restaurants
    where id = '64100000-0000-4000-8000-000000000001'
  ) or not exists (
    select 1
    from public.api_idempotency
    where user_id = '64000000-0000-4000-8000-000000000001'
      and idempotency_key = 'delete_replay_key_0067'
      and restaurant_id = '64100000-0000-4000-8000-000000000001'
      and operation_id = 'api:DELETE:/api/restaurant/{param}'
      and state = 'completed'
      and response_status = 200
      and response_body = '{"ok":true}'::jsonb
  ) then
    raise exception 'delete did not preserve one completed replay record';
  end if;
end;
$$;

-- A completion failure rolls the root delete and its claim back together.
create or replace function public.reject_restaurant_delete_completion_0067()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.operation_id = 'api:DELETE:/api/restaurant/{param}'
     and new.idempotency_key = 'delete_rollback_key_0067'
     and new.state = 'completed' then
    raise exception using
      errcode = '40001',
      message = 'forced completion failure';
  end if;
  return new;
end;
$$;

create trigger reject_restaurant_delete_completion_0067
before update on public.api_idempotency
for each row
execute function public.reject_restaurant_delete_completion_0067();

select set_config(
  'request.jwt.claim.sub',
  '64000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;
do $$
begin
  begin
    perform *
    from public.delete_restaurant_idempotent(
      '64100000-0000-4000-8000-000000000003',
      '64100000-0000-4000-8000-000000000003',
      'delete_rollback_key_0067',
      pg_temp.request_hash(
        '64100000-0000-4000-8000-000000000003'
      )
    );
  exception when sqlstate '40001' then
    return;
  end;
  raise exception 'forced completion failure did not abort';
end;
$$;
reset role;

do $$
begin
  if not exists (
    select 1
    from public.restaurants
    where id = '64100000-0000-4000-8000-000000000003'
  ) or exists (
    select 1
    from public.api_idempotency
    where idempotency_key = 'delete_rollback_key_0067'
  ) then
    raise exception 'completion failure did not roll back atomically';
  end if;
end;
$$;

drop trigger reject_restaurant_delete_completion_0067
  on public.api_idempotency;
drop function public.reject_restaurant_delete_completion_0067();

delete from public.api_idempotency
where user_id::text like '64000000-0000-4000-8000-00000000000%';
delete from public.restaurants
where id::text like '64100000-0000-4000-8000-00000000000%';
delete from auth.users
where id::text like '64000000-0000-4000-8000-00000000000%';

select set_config('request.jwt.claim.sub', '', false);
