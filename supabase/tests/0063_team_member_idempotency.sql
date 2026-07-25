-- Focused acceptance for 0063_team_member_idempotency.sql.
-- Run only against an isolated database with migrations through 0063:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -v dblink_conn="$DATABASE_URL" \
--     -f supabase/tests/0063_team_member_idempotency.sql

\if :{?dblink_conn}
\else
\echo '0063 acceptance requires -v dblink_conn=<password-authenticated database URL>'
\quit 2
\endif

create extension if not exists dblink with schema extensions;

drop trigger if exists audit_team_member_mutation_0063
  on public.memberships;
drop trigger if exists reject_team_member_completion_0063
  on public.api_idempotency;
drop trigger if exists delay_team_member_completion_0063
  on public.api_idempotency;
drop trigger if exists delay_owner_demotion_0063
  on public.memberships;
drop function if exists public.audit_team_member_mutation_0063();
drop function if exists public.reject_team_member_completion_0063();
drop function if exists public.delay_team_member_completion_0063();
drop function if exists public.delay_owner_demotion_0063();
drop table if exists public.team_member_mutation_audit_0063;

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
        'unexpected failure for "%": expected %, received %',
        p_sql,
        p_sqlstate,
        v_sqlstate;
    end if;
    return;
  end;

  raise exception using
    errcode = 'P0001',
    message = 'expected statement to fail: ' || p_sql;
end;
$$;

delete from public.restaurants
where id in (
  '63100000-0000-4000-8000-000000000001',
  '63100000-0000-4000-8000-000000000002'
);
delete from auth.users
where id::text like '63000000-0000-4000-8000-00000000000%';

insert into auth.users (
  id,
  email,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
) values
  (
    '63000000-0000-4000-8000-000000000001',
    'owner-a-0063@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '63000000-0000-4000-8000-000000000002',
    'owner-b-0063@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '63000000-0000-4000-8000-000000000003',
    'staff-0063@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '63000000-0000-4000-8000-000000000004',
    'other-owner-0063@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '63000000-0000-4000-8000-000000000005',
    'remove-a-0063@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '63000000-0000-4000-8000-000000000006',
    'rollback-a-0063@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '63000000-0000-4000-8000-000000000007',
    'outsider-0063@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

insert into public.restaurants (id, name) values
  (
    '63100000-0000-4000-8000-000000000001',
    'Atomic Team Restaurant A'
  ),
  (
    '63100000-0000-4000-8000-000000000002',
    'Atomic Team Restaurant B'
  );

insert into public.memberships (
  id,
  user_id,
  restaurant_id,
  role
) values
  (
    '63300000-0000-4000-8000-000000000001',
    '63000000-0000-4000-8000-000000000001',
    '63100000-0000-4000-8000-000000000001',
    'owner'
  ),
  (
    '63300000-0000-4000-8000-000000000002',
    '63000000-0000-4000-8000-000000000002',
    '63100000-0000-4000-8000-000000000001',
    'owner'
  ),
  (
    '63300000-0000-4000-8000-000000000003',
    '63000000-0000-4000-8000-000000000003',
    '63100000-0000-4000-8000-000000000001',
    'staff'
  ),
  (
    '63300000-0000-4000-8000-000000000004',
    '63000000-0000-4000-8000-000000000004',
    '63100000-0000-4000-8000-000000000002',
    'owner'
  ),
  (
    '63300000-0000-4000-8000-000000000005',
    '63000000-0000-4000-8000-000000000005',
    '63100000-0000-4000-8000-000000000001',
    'staff'
  ),
  (
    '63300000-0000-4000-8000-000000000006',
    '63000000-0000-4000-8000-000000000006',
    '63100000-0000-4000-8000-000000000001',
    'staff'
  );

create table public.team_member_mutation_audit_0063 (
  kind text not null,
  membership_id uuid not null
);

create or replace function public.audit_team_member_mutation_0063()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  insert into public.team_member_mutation_audit_0063 (
    kind,
    membership_id
  ) values (
    tg_op,
    coalesce(new.id, old.id)
  );
  return coalesce(new, old);
end;
$$;

create trigger audit_team_member_mutation_0063
after update or delete on public.memberships
for each row
execute function public.audit_team_member_mutation_0063();

-- Privileges and hardened execution context are exact.
do $$
begin
  if has_function_privilege(
    'anon',
    'public.update_team_member_role_idempotent(uuid,uuid,public.membership_role,text,text)',
    'EXECUTE'
  ) or has_function_privilege(
    'anon',
    'public.remove_team_member_idempotent(uuid,uuid,text,text)',
    'EXECUTE'
  ) then
    raise exception 'anon retains team member idempotency execution';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.update_team_member_role_idempotent(uuid,uuid,public.membership_role,text,text)',
    'EXECUTE'
  ) or not has_function_privilege(
    'authenticated',
    'public.remove_team_member_idempotent(uuid,uuid,text,text)',
    'EXECUTE'
  ) then
    raise exception 'authenticated lacks team member idempotency execution';
  end if;

  if exists (
    select 1
    from pg_proc
    where oid in (
      to_regprocedure(
        'public.update_team_member_role_idempotent(uuid,uuid,public.membership_role,text,text)'
      ),
      to_regprocedure(
        'public.remove_team_member_idempotent(uuid,uuid,text,text)'
      )
    )
      and (
        not prosecdef
        or not (
          coalesce(proconfig, '{}'::text[])
          @> array['search_path=""']::text[]
        )
      )
  ) then
    raise exception 'team member RPC execution context is not hardened';
  end if;
end;
$$;

-- Authentication, owner role, and tenant authorization are enforced in the
-- database independently of the route guard.
select set_config('request.jwt.claim.sub', '', false);
set role authenticated;
select pg_temp.expect_failure(
  $sql$
    select * from public.update_team_member_role_idempotent(
      '63100000-0000-4000-8000-000000000001',
      '63300000-0000-4000-8000-000000000003',
      'manager'
    )
  $sql$,
  '42501'
);
select pg_temp.expect_failure(
  $sql$
    select * from public.remove_team_member_idempotent(
      '63100000-0000-4000-8000-000000000001',
      '63300000-0000-4000-8000-000000000005'
    )
  $sql$,
  '42501'
);
reset role;

select set_config(
  'request.jwt.claim.sub',
  '63000000-0000-4000-8000-000000000007',
  false
);
set role authenticated;
select pg_temp.expect_failure(
  $sql$
    select * from public.update_team_member_role_idempotent(
      '63100000-0000-4000-8000-000000000001',
      '63300000-0000-4000-8000-000000000003',
      'manager'
    )
  $sql$,
  '42501'
);
reset role;

select set_config(
  'request.jwt.claim.sub',
  '63000000-0000-4000-8000-000000000003',
  false
);
set role authenticated;
select pg_temp.expect_failure(
  $sql$
    select * from public.remove_team_member_idempotent(
      '63100000-0000-4000-8000-000000000001',
      '63300000-0000-4000-8000-000000000005'
    )
  $sql$,
  '42501'
);
reset role;

-- Direct false hashes fail before any claim or mutation.
select set_config(
  'request.jwt.claim.sub',
  '63000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;
select pg_temp.expect_failure(
  $sql$
    select * from public.update_team_member_role_idempotent(
      '63100000-0000-4000-8000-000000000001',
      '63300000-0000-4000-8000-000000000003',
      'manager',
      'role_false_hash_0063',
      repeat('a', 64)
    )
  $sql$,
  '22023'
);
select pg_temp.expect_failure(
  $sql$
    select * from public.remove_team_member_idempotent(
      '63100000-0000-4000-8000-000000000001',
      '63300000-0000-4000-8000-000000000005',
      'remove_false_hash_0063',
      repeat('b', 64)
    )
  $sql$,
  '22023'
);
reset role;

do $$
begin
  if exists (
    select 1
    from public.api_idempotency
    where idempotency_key in (
      'role_false_hash_0063',
      'remove_false_hash_0063'
    )
  ) or exists (
    select 1
    from public.team_member_mutation_audit_0063
  ) then
    raise exception 'false hash created a claim or mutation';
  end if;
end;
$$;

-- Keyless compatibility keeps the existing success bodies and creates no
-- idempotency records.
select set_config(
  'request.jwt.claim.sub',
  '63000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;
do $$
declare
  v_role record;
  v_remove record;
begin
  select * into v_role
  from public.update_team_member_role_idempotent(
    '63100000-0000-4000-8000-000000000001',
    '63300000-0000-4000-8000-000000000003',
    'manager'
  );
  if v_role.outcome <> 'updated'
     or v_role.response_status <> 200
     or v_role.response_body <> '{"success":true}'::jsonb
     or v_role.replayed then
    raise exception 'keyless role response malformed: %', row_to_json(v_role);
  end if;

  select * into v_remove
  from public.remove_team_member_idempotent(
    '63100000-0000-4000-8000-000000000001',
    '63300000-0000-4000-8000-000000000005'
  );
  if v_remove.outcome <> 'removed'
     or v_remove.response_status <> 200
     or v_remove.response_body <> '{"success":true}'::jsonb
     or v_remove.replayed then
    raise exception 'keyless remove response malformed: %',
      row_to_json(v_remove);
  end if;
end;
$$;
reset role;

do $$
begin
  if exists (
    select 1
    from public.api_idempotency
    where user_id = '63000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'keyless team command created a claim';
  end if;
end;
$$;

-- Restore keyless fixtures outside the audited acceptance paths.
drop trigger audit_team_member_mutation_0063 on public.memberships;
update public.memberships
set role = 'staff'
where id = '63300000-0000-4000-8000-000000000003';
insert into public.memberships (
  id,
  user_id,
  restaurant_id,
  role
) values (
  '63300000-0000-4000-8000-000000000005',
  '63000000-0000-4000-8000-000000000005',
  '63100000-0000-4000-8000-000000000001',
  'staff'
);
truncate public.team_member_mutation_audit_0063;
create trigger audit_team_member_mutation_0063
after update or delete on public.memberships
for each row
execute function public.audit_team_member_mutation_0063();

-- Exact deterministic 404, self-delete, and last-owner envelopes are stored
-- and replayed byte-for-byte.
select set_config(
  'request.jwt.claim.sub',
  '63000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;
do $$
declare
  v_fresh record;
  v_replay record;
begin
  select * into v_fresh
  from public.update_team_member_role_idempotent(
    '63100000-0000-4000-8000-000000000001',
    '63300000-0000-4000-8000-000000000099',
    'staff',
    'role_missing_key_0063',
    'c1ca19b5510f83b619cd77bac747a69d4e849007bb74481475a47b4147ea4450'
  );
  select * into v_replay
  from public.update_team_member_role_idempotent(
    '63100000-0000-4000-8000-000000000001',
    '63300000-0000-4000-8000-000000000099',
    'staff',
    'role_missing_key_0063',
    'c1ca19b5510f83b619cd77bac747a69d4e849007bb74481475a47b4147ea4450'
  );
  if v_fresh.outcome <> 'not_found'
     or v_fresh.response_status <> 404
     or v_fresh.response_body <> jsonb_build_object(
       'error',
       jsonb_build_object(
         'code', 'not_found',
         'message', 'Member not found.'
       )
     )
     or v_replay.outcome <> 'replay'
     or v_replay.response_body <> v_fresh.response_body
     or not v_replay.replayed then
    raise exception 'role 404 replay malformed: fresh=%, replay=%',
      row_to_json(v_fresh),
      row_to_json(v_replay);
  end if;

  select * into v_fresh
  from public.remove_team_member_idempotent(
    '63100000-0000-4000-8000-000000000001',
    '63300000-0000-4000-8000-000000000099',
    'remove_missing_key_0063',
    '6cfda42c1d3dd67c53276b99416ed22adb053d9b1de6a13d364307374a669563'
  );
  select * into v_replay
  from public.remove_team_member_idempotent(
    '63100000-0000-4000-8000-000000000001',
    '63300000-0000-4000-8000-000000000099',
    'remove_missing_key_0063',
    '6cfda42c1d3dd67c53276b99416ed22adb053d9b1de6a13d364307374a669563'
  );
  if v_fresh.outcome <> 'not_found'
     or v_fresh.response_status <> 404
     or v_fresh.response_body <> jsonb_build_object(
       'error',
       jsonb_build_object(
         'code', 'not_found',
         'message', 'Member not found.'
       )
     )
     or v_replay.outcome <> 'replay'
     or v_replay.response_body <> v_fresh.response_body
     or not v_replay.replayed then
    raise exception 'remove 404 replay malformed: fresh=%, replay=%',
      row_to_json(v_fresh),
      row_to_json(v_replay);
  end if;

  select * into v_fresh
  from public.remove_team_member_idempotent(
    '63100000-0000-4000-8000-000000000001',
    '63300000-0000-4000-8000-000000000001',
    'remove_self_key_0063',
    '121b7c6ff1a7946520a414100b6bb7724ebee50f7b49051b54f885c194c08c3d'
  );
  select * into v_replay
  from public.remove_team_member_idempotent(
    '63100000-0000-4000-8000-000000000001',
    '63300000-0000-4000-8000-000000000001',
    'remove_self_key_0063',
    '121b7c6ff1a7946520a414100b6bb7724ebee50f7b49051b54f885c194c08c3d'
  );
  if v_fresh.outcome <> 'self_removal'
     or v_fresh.response_status <> 400
     or v_fresh.response_body <> jsonb_build_object(
       'error',
       jsonb_build_object(
         'code', 'bad_request',
         'message', 'Cannot remove yourself.'
       )
     )
     or v_replay.outcome <> 'replay'
     or v_replay.response_body <> v_fresh.response_body then
    raise exception 'self-remove replay malformed: fresh=%, replay=%',
      row_to_json(v_fresh),
      row_to_json(v_replay);
  end if;
end;
$$;
reset role;

-- Make owner A the only owner and verify demotion is rejected exactly.
drop trigger audit_team_member_mutation_0063 on public.memberships;
update public.memberships
set role = 'staff'
where id = '63300000-0000-4000-8000-000000000002';
create trigger audit_team_member_mutation_0063
after update or delete on public.memberships
for each row
execute function public.audit_team_member_mutation_0063();

select set_config(
  'request.jwt.claim.sub',
  '63000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;
do $$
declare
  v_result record;
begin
  select * into v_result
  from public.update_team_member_role_idempotent(
    '63100000-0000-4000-8000-000000000001',
    '63300000-0000-4000-8000-000000000001',
    'staff',
    'role_last_owner_key_0063',
    'd5b437751c2b91d655d3603ca9c45596933e31035ef8aa79942416db389d22c0'
  );
  if v_result.outcome <> 'last_owner'
     or v_result.response_status <> 400
     or v_result.response_body <> jsonb_build_object(
       'error',
       jsonb_build_object(
         'code', 'bad_request',
         'message', 'Cannot demote the last owner.'
       )
     ) then
    raise exception 'last-owner response malformed: %', row_to_json(v_result);
  end if;
end;
$$;
reset role;

drop trigger audit_team_member_mutation_0063 on public.memberships;
update public.memberships
set role = 'owner'
where id = '63300000-0000-4000-8000-000000000002';
truncate public.team_member_mutation_audit_0063;
create trigger audit_team_member_mutation_0063
after update or delete on public.memberships
for each row
execute function public.audit_team_member_mutation_0063();

-- Lost-response retries replay without a second role update or delete.
select set_config(
  'request.jwt.claim.sub',
  '63000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;
do $$
declare
  v_fresh record;
  v_replay record;
begin
  select * into v_fresh
  from public.update_team_member_role_idempotent(
    '63100000-0000-4000-8000-000000000001',
    '63300000-0000-4000-8000-000000000003',
    'manager',
    'role_replay_key_0063',
    'ef06d521eeb9b2dbfa68fa2d0e0ab84e836cef437c03b3122bf2ba30c6c899ea'
  );
  select * into v_replay
  from public.update_team_member_role_idempotent(
    '63100000-0000-4000-8000-000000000001',
    '63300000-0000-4000-8000-000000000003',
    'manager',
    'role_replay_key_0063',
    'ef06d521eeb9b2dbfa68fa2d0e0ab84e836cef437c03b3122bf2ba30c6c899ea'
  );
  if v_fresh.outcome <> 'updated'
     or v_fresh.response_body <> '{"success":true}'::jsonb
     or v_replay.outcome <> 'replay'
     or v_replay.response_body <> v_fresh.response_body
     or v_replay.execution_started_at <> v_fresh.execution_started_at
     or not v_replay.replayed then
    raise exception 'role lost-response replay malformed';
  end if;

  select * into v_fresh
  from public.remove_team_member_idempotent(
    '63100000-0000-4000-8000-000000000001',
    '63300000-0000-4000-8000-000000000005',
    'remove_replay_key_0063',
    '8ab76defea81c9ae02f292db9927cd15294a1cbb1d58957ae738357506e0356c'
  );
  select * into v_replay
  from public.remove_team_member_idempotent(
    '63100000-0000-4000-8000-000000000001',
    '63300000-0000-4000-8000-000000000005',
    'remove_replay_key_0063',
    '8ab76defea81c9ae02f292db9927cd15294a1cbb1d58957ae738357506e0356c'
  );
  if v_fresh.outcome <> 'removed'
     or v_fresh.response_body <> '{"success":true}'::jsonb
     or v_replay.outcome <> 'replay'
     or v_replay.response_body <> v_fresh.response_body
     or not v_replay.replayed then
    raise exception 'remove lost-response replay malformed';
  end if;
end;
$$;
reset role;

do $$
begin
  if (
    select count(*)
    from public.team_member_mutation_audit_0063
    where kind = 'UPDATE'
      and membership_id = '63300000-0000-4000-8000-000000000003'
  ) <> 1 or (
    select count(*)
    from public.team_member_mutation_audit_0063
    where kind = 'DELETE'
      and membership_id = '63300000-0000-4000-8000-000000000005'
  ) <> 1 then
    raise exception 'replay executed a second team mutation';
  end if;
end;
$$;

-- The same caller key cannot change body, operation, or tenant.
select set_config(
  'request.jwt.claim.sub',
  '63000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;
do $$
declare
  v_result record;
begin
  select * into v_result
  from public.update_team_member_role_idempotent(
    '63100000-0000-4000-8000-000000000001',
    '63300000-0000-4000-8000-000000000003',
    'owner',
    'role_replay_key_0063',
    '6d388468a2d43c575098b57b0957b864bf155218270b92102467e51df07a0bef'
  );
  if v_result.outcome <> 'idempotency_key_reused'
     or v_result.response_status <> 409
     or v_result.response_body #>> '{error,code}'
          <> 'idempotency_key_reused' then
    raise exception 'changed role did not conflict with stored key';
  end if;

  select * into v_result
  from public.remove_team_member_idempotent(
    '63100000-0000-4000-8000-000000000001',
    '63300000-0000-4000-8000-000000000003',
    'role_replay_key_0063',
    'a5fc8ba2a489c20c42479e6f453ede49a39691ec6c0eb1d69160967a78cc161d'
  );
  if v_result.outcome <> 'idempotency_key_reused' then
    raise exception 'changed operation did not conflict with stored key';
  end if;
end;
$$;
reset role;

-- A selected-tenant owner sees a foreign membership only as not found.
select set_config(
  'request.jwt.claim.sub',
  '63000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;
do $$
declare
  v_result record;
begin
  select * into v_result
  from public.update_team_member_role_idempotent(
    '63100000-0000-4000-8000-000000000001',
    '63300000-0000-4000-8000-000000000004',
    'staff'
  );
  if v_result.outcome <> 'not_found' then
    raise exception 'foreign member leaked through tenant boundary';
  end if;

  select * into v_result
  from public.remove_team_member_idempotent(
    '63100000-0000-4000-8000-000000000001',
    '63300000-0000-4000-8000-000000000004'
  );
  if v_result.outcome <> 'not_found' then
    raise exception 'foreign removal leaked through tenant boundary';
  end if;
end;
$$;
reset role;

-- Completion failure rolls back each business mutation and claim. Retrying
-- the exact key after removing the induced failure executes and replays once.
create or replace function public.reject_team_member_completion_0063()
returns trigger
language plpgsql
as $$
begin
  raise exception using
    errcode = 'XX000',
    message = 'induced 0063 idempotency completion failure';
end;
$$;

create trigger reject_team_member_completion_0063
before update on public.api_idempotency
for each row
when (
  new.idempotency_key in (
    'role_rollback_key_0063',
    'remove_rollback_key_0063'
  )
)
execute function public.reject_team_member_completion_0063();

truncate public.team_member_mutation_audit_0063;
select set_config(
  'request.jwt.claim.sub',
  '63000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;
select pg_temp.expect_failure(
  $sql$
    select * from public.update_team_member_role_idempotent(
      '63100000-0000-4000-8000-000000000001',
      '63300000-0000-4000-8000-000000000006',
      'manager',
      'role_rollback_key_0063',
      'b1d54b94f27f5dd75864ca59718a8b21b4e56a6c2840d59e6320a04db428616c'
    )
  $sql$,
  'XX000'
);
select pg_temp.expect_failure(
  $sql$
    select * from public.remove_team_member_idempotent(
      '63100000-0000-4000-8000-000000000001',
      '63300000-0000-4000-8000-000000000006',
      'remove_rollback_key_0063',
      '23499c61ef6fb9ba80713e80872a0e20e2199d68d2fe84c614ab985c5cdb7b3c'
    )
  $sql$,
  'XX000'
);
reset role;
drop trigger reject_team_member_completion_0063
  on public.api_idempotency;

do $$
begin
  if (
    select role
    from public.memberships
    where id = '63300000-0000-4000-8000-000000000006'
  ) <> 'staff'
     or exists (
       select 1
       from public.team_member_mutation_audit_0063
     )
     or exists (
       select 1
       from public.api_idempotency
       where idempotency_key in (
         'role_rollback_key_0063',
         'remove_rollback_key_0063'
       )
     ) then
    raise exception 'completion failure leaked a mutation or claim';
  end if;
end;
$$;

select set_config(
  'request.jwt.claim.sub',
  '63000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;
do $$
declare
  v_fresh record;
  v_replay record;
begin
  select * into v_fresh
  from public.update_team_member_role_idempotent(
    '63100000-0000-4000-8000-000000000001',
    '63300000-0000-4000-8000-000000000006',
    'manager',
    'role_rollback_key_0063',
    'b1d54b94f27f5dd75864ca59718a8b21b4e56a6c2840d59e6320a04db428616c'
  );
  select * into v_replay
  from public.update_team_member_role_idempotent(
    '63100000-0000-4000-8000-000000000001',
    '63300000-0000-4000-8000-000000000006',
    'manager',
    'role_rollback_key_0063',
    'b1d54b94f27f5dd75864ca59718a8b21b4e56a6c2840d59e6320a04db428616c'
  );
  if v_fresh.outcome <> 'updated'
     or v_replay.outcome <> 'replay' then
    raise exception 'role rollback retry did not execute/replay';
  end if;

  select * into v_fresh
  from public.remove_team_member_idempotent(
    '63100000-0000-4000-8000-000000000001',
    '63300000-0000-4000-8000-000000000006',
    'remove_rollback_key_0063',
    '23499c61ef6fb9ba80713e80872a0e20e2199d68d2fe84c614ab985c5cdb7b3c'
  );
  select * into v_replay
  from public.remove_team_member_idempotent(
    '63100000-0000-4000-8000-000000000001',
    '63300000-0000-4000-8000-000000000006',
    'remove_rollback_key_0063',
    '23499c61ef6fb9ba80713e80872a0e20e2199d68d2fe84c614ab985c5cdb7b3c'
  );
  if v_fresh.outcome <> 'removed'
     or v_replay.outcome <> 'replay' then
    raise exception 'remove rollback retry did not execute/replay';
  end if;
end;
$$;
reset role;

-- Real same-key concurrency: two independent sessions overlap completion.
insert into public.memberships (
  id,
  user_id,
  restaurant_id,
  role
) values (
  '63300000-0000-4000-8000-000000000005',
  '63000000-0000-4000-8000-000000000005',
  '63100000-0000-4000-8000-000000000001',
  'staff'
);
truncate public.team_member_mutation_audit_0063;

create or replace function public.delay_team_member_completion_0063()
returns trigger
language plpgsql
as $$
begin
  perform pg_sleep(0.75);
  return new;
end;
$$;

create trigger delay_team_member_completion_0063
before update on public.api_idempotency
for each row
when (new.idempotency_key = 'role_concurrent_key_0063')
execute function public.delay_team_member_completion_0063();

select extensions.dblink_connect('team_0063_a', :'dblink_conn');
select extensions.dblink_connect('team_0063_b', :'dblink_conn');
select extensions.dblink_exec(
  'team_0063_a',
  $sql$
    set "request.jwt.claim.sub" =
      '63000000-0000-4000-8000-000000000001'
  $sql$
);
select extensions.dblink_exec(
  'team_0063_b',
  $sql$
    set "request.jwt.claim.sub" =
      '63000000-0000-4000-8000-000000000001'
  $sql$
);
select extensions.dblink_exec('team_0063_a', 'set role authenticated');
select extensions.dblink_exec('team_0063_b', 'set role authenticated');
select extensions.dblink_send_query(
  'team_0063_a',
  $sql$
    select row_to_json(result)::text
    from public.update_team_member_role_idempotent(
      '63100000-0000-4000-8000-000000000001',
      '63300000-0000-4000-8000-000000000005',
      'manager',
      'role_concurrent_key_0063',
      'b6c2a0be6eb343c866582772c183801031ef070c1b2da89af76e138b31f5afa5'
    ) as result
  $sql$
);
select extensions.dblink_send_query(
  'team_0063_b',
  $sql$
    select row_to_json(result)::text
    from public.update_team_member_role_idempotent(
      '63100000-0000-4000-8000-000000000001',
      '63300000-0000-4000-8000-000000000005',
      'manager',
      'role_concurrent_key_0063',
      'b6c2a0be6eb343c866582772c183801031ef070c1b2da89af76e138b31f5afa5'
    ) as result
  $sql$
);

create temporary table team_0063_concurrency_results (
  payload jsonb not null
);
insert into team_0063_concurrency_results (payload)
select payload::jsonb
from extensions.dblink_get_result('team_0063_a') as result(payload text);
insert into team_0063_concurrency_results (payload)
select payload::jsonb
from extensions.dblink_get_result('team_0063_b') as result(payload text);
select extensions.dblink_disconnect('team_0063_a');
select extensions.dblink_disconnect('team_0063_b');
drop trigger delay_team_member_completion_0063
  on public.api_idempotency;

do $$
declare
  v_fresh jsonb;
  v_replay jsonb;
begin
  if (
    select count(*)
    from team_0063_concurrency_results
    where payload ->> 'outcome' = 'updated'
  ) <> 1 or (
    select count(*)
    from team_0063_concurrency_results
    where payload ->> 'outcome' = 'replay'
  ) <> 1 or (
    select count(*)
    from public.team_member_mutation_audit_0063
    where kind = 'UPDATE'
      and membership_id = '63300000-0000-4000-8000-000000000005'
  ) <> 1 then
    raise exception 'same-key concurrency duplicated role mutation: %',
      (select jsonb_agg(payload) from team_0063_concurrency_results);
  end if;

  select payload into strict v_fresh
  from team_0063_concurrency_results
  where payload ->> 'outcome' = 'updated';
  select payload into strict v_replay
  from team_0063_concurrency_results
  where payload ->> 'outcome' = 'replay';
  if v_fresh -> 'response_body' <> v_replay -> 'response_body'
     or v_fresh ->> 'execution_started_at'
          <> v_replay ->> 'execution_started_at' then
    raise exception 'concurrent role replay was not exact';
  end if;
end;
$$;

-- Different actors and keys concurrently demote themselves. The set lock
-- allows one demotion; the second observes the remaining-owner invariant.
truncate public.team_member_mutation_audit_0063;
drop trigger audit_team_member_mutation_0063 on public.memberships;
update public.memberships
set role = 'owner'
where id in (
  '63300000-0000-4000-8000-000000000001',
  '63300000-0000-4000-8000-000000000002'
);
create trigger audit_team_member_mutation_0063
after update or delete on public.memberships
for each row
execute function public.audit_team_member_mutation_0063();

create or replace function public.delay_owner_demotion_0063()
returns trigger
language plpgsql
as $$
begin
  if old.role = 'owner' and new.role <> 'owner' then
    perform pg_sleep(0.75);
  end if;
  return new;
end;
$$;

create trigger delay_owner_demotion_0063
before update on public.memberships
for each row
when (
  old.id in (
    '63300000-0000-4000-8000-000000000001'::uuid,
    '63300000-0000-4000-8000-000000000002'::uuid
  )
)
execute function public.delay_owner_demotion_0063();

select extensions.dblink_connect('owners_0063_a', :'dblink_conn');
select extensions.dblink_connect('owners_0063_b', :'dblink_conn');
select extensions.dblink_exec(
  'owners_0063_a',
  $sql$
    set "request.jwt.claim.sub" =
      '63000000-0000-4000-8000-000000000001'
  $sql$
);
select extensions.dblink_exec(
  'owners_0063_b',
  $sql$
    set "request.jwt.claim.sub" =
      '63000000-0000-4000-8000-000000000002'
  $sql$
);
select extensions.dblink_exec('owners_0063_a', 'set role authenticated');
select extensions.dblink_exec('owners_0063_b', 'set role authenticated');
select extensions.dblink_send_query(
  'owners_0063_a',
  $sql$
    select row_to_json(result)::text
    from public.update_team_member_role_idempotent(
      '63100000-0000-4000-8000-000000000001',
      '63300000-0000-4000-8000-000000000001',
      'staff',
      'owner_a_demotion_key_0063',
      'd5b437751c2b91d655d3603ca9c45596933e31035ef8aa79942416db389d22c0'
    ) as result
  $sql$
);
select extensions.dblink_send_query(
  'owners_0063_b',
  $sql$
    select row_to_json(result)::text
    from public.update_team_member_role_idempotent(
      '63100000-0000-4000-8000-000000000001',
      '63300000-0000-4000-8000-000000000002',
      'staff',
      'owner_b_demotion_key_0063',
      '01d4252875dca7bf51dc3d5c25e51a0edc024cbd0dccd2669498adb1ab703336'
    ) as result
  $sql$
);

create temporary table owner_0063_concurrency_results (
  payload jsonb not null
);
insert into owner_0063_concurrency_results (payload)
select payload::jsonb
from extensions.dblink_get_result('owners_0063_a') as result(payload text);
insert into owner_0063_concurrency_results (payload)
select payload::jsonb
from extensions.dblink_get_result('owners_0063_b') as result(payload text);
select extensions.dblink_disconnect('owners_0063_a');
select extensions.dblink_disconnect('owners_0063_b');
drop trigger delay_owner_demotion_0063 on public.memberships;

do $$
begin
  if (
    select count(*)
    from owner_0063_concurrency_results
    where payload ->> 'outcome' = 'updated'
  ) <> 1 or (
    select count(*)
    from owner_0063_concurrency_results
    where payload ->> 'outcome' = 'last_owner'
      and payload #>> '{response_body,error,message}'
            = 'Cannot demote the last owner.'
  ) <> 1 or (
    select count(*)
    from public.memberships
    where restaurant_id = '63100000-0000-4000-8000-000000000001'
      and role = 'owner'
  ) <> 1 then
    raise exception 'concurrent owner demotion violated invariant: %',
      (select jsonb_agg(payload) from owner_0063_concurrency_results);
  end if;
end;
$$;

drop trigger audit_team_member_mutation_0063 on public.memberships;
drop function public.audit_team_member_mutation_0063();
drop function public.reject_team_member_completion_0063();
drop function public.delay_team_member_completion_0063();
drop function public.delay_owner_demotion_0063();
drop table public.team_member_mutation_audit_0063;

delete from public.restaurants
where id in (
  '63100000-0000-4000-8000-000000000001',
  '63100000-0000-4000-8000-000000000002'
);
delete from auth.users
where id::text like '63000000-0000-4000-8000-00000000000%';

select '0063 team member idempotency acceptance passed' as result;
