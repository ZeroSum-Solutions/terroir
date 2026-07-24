-- Focused acceptance test for 0057_atomic_idempotent_commands.sql.
-- Run only against an isolated database with migrations through 0057 applied:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f supabase/tests/0057_atomic_idempotent_commands.sql

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

insert into auth.users (
  id,
  email,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
) values
  (
    '57000000-0000-4000-8000-000000000001',
    'owner-0057@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '57000000-0000-4000-8000-000000000002',
    'staff-0057@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '57000000-0000-4000-8000-000000000003',
    'outsider-0057@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '57000000-0000-4000-8000-000000000004',
    'invitee-0057@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '57000000-0000-4000-8000-000000000005',
    'used-0057@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '57000000-0000-4000-8000-000000000006',
    'expired-0057@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '57000000-0000-4000-8000-000000000007',
    'state-0057@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '57000000-0000-4000-8000-000000000008',
    'rollback-0057@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

insert into public.restaurants (id, name) values
  (
    '57100000-0000-4000-8000-000000000001',
    'Atomic Commands Restaurant A'
  ),
  (
    '57100000-0000-4000-8000-000000000002',
    'Atomic Commands Restaurant B'
  );

insert into public.memberships (user_id, restaurant_id, role) values
  (
    '57000000-0000-4000-8000-000000000001',
    '57100000-0000-4000-8000-000000000001',
    'owner'
  ),
  (
    '57000000-0000-4000-8000-000000000002',
    '57100000-0000-4000-8000-000000000001',
    'staff'
  );

insert into public.wines (
  id,
  restaurant_id,
  name,
  producer,
  size_ml
) values
  (
    '57200000-0000-4000-8000-000000000001',
    '57100000-0000-4000-8000-000000000001',
    'Fresh Open',
    '0057 Producer',
    750
  ),
  (
    '57200000-0000-4000-8000-000000000002',
    '57100000-0000-4000-8000-000000000001',
    'No Stock',
    '0057 Producer',
    750
  ),
  (
    '57200000-0000-4000-8000-000000000003',
    '57100000-0000-4000-8000-000000000001',
    'Rollback Open',
    '0057 Producer',
    750
  ),
  (
    '57200000-0000-4000-8000-000000000004',
    '57100000-0000-4000-8000-000000000002',
    'Foreign Wine',
    '0057 Producer',
    1500
  ),
  (
    '57200000-0000-4000-8000-000000000005',
    '57100000-0000-4000-8000-000000000001',
    'Closed Reopen',
    '0057 Producer',
    375
  );

insert into public.inventory_items (
  id,
  wine_id,
  restaurant_id,
  quantity,
  unit_cost,
  added_at
) values
  (
    '57300000-0000-4000-8000-000000000001',
    '57200000-0000-4000-8000-000000000001',
    '57100000-0000-4000-8000-000000000001',
    2,
    20,
    now() - interval '2 days'
  ),
  (
    '57300000-0000-4000-8000-000000000002',
    '57200000-0000-4000-8000-000000000001',
    '57100000-0000-4000-8000-000000000001',
    2,
    21,
    now() - interval '1 day'
  ),
  (
    '57300000-0000-4000-8000-000000000003',
    '57200000-0000-4000-8000-000000000002',
    '57100000-0000-4000-8000-000000000001',
    0,
    22,
    now()
  ),
  (
    '57300000-0000-4000-8000-000000000004',
    '57200000-0000-4000-8000-000000000003',
    '57100000-0000-4000-8000-000000000001',
    1,
    23,
    now()
  ),
  (
    '57300000-0000-4000-8000-000000000005',
    '57200000-0000-4000-8000-000000000004',
    '57100000-0000-4000-8000-000000000002',
    1,
    24,
    now()
  ),
  (
    '57300000-0000-4000-8000-000000000006',
    '57200000-0000-4000-8000-000000000005',
    '57100000-0000-4000-8000-000000000001',
    1,
    25,
    now()
  );

insert into public.open_bottles (
  id,
  wine_id,
  restaurant_id,
  remaining_ml,
  opened_by,
  source_inventory_item_id,
  closed_at
) values (
  '57500000-0000-4000-8000-000000000001',
  '57200000-0000-4000-8000-000000000005',
  '57100000-0000-4000-8000-000000000001',
  0,
  '57000000-0000-4000-8000-000000000001',
  '57300000-0000-4000-8000-000000000006',
  now() - interval '1 hour'
);

insert into public.invitations (
  id,
  restaurant_id,
  email,
  role,
  invited_by,
  token,
  expires_at,
  accepted_at
) values
  (
    '57400000-0000-4000-8000-000000000001',
    '57100000-0000-4000-8000-000000000001',
    ' INVITEE-0057@EXAMPLE.TEST ',
    'staff',
    '57000000-0000-4000-8000-000000000001',
    'token_accept_0057',
    now() + interval '1 day',
    null
  ),
  (
    '57400000-0000-4000-8000-000000000002',
    '57100000-0000-4000-8000-000000000001',
    'owner-0057@example.test',
    'staff',
    '57000000-0000-4000-8000-000000000001',
    'token_existing_0057',
    now() + interval '1 day',
    null
  ),
  (
    '57400000-0000-4000-8000-000000000003',
    '57100000-0000-4000-8000-000000000001',
    'target-0057@example.test',
    'manager',
    '57000000-0000-4000-8000-000000000001',
    'token_mismatch_0057',
    now() + interval '1 day',
    null
  ),
  (
    '57400000-0000-4000-8000-000000000004',
    '57100000-0000-4000-8000-000000000001',
    'used-0057@example.test',
    'staff',
    '57000000-0000-4000-8000-000000000001',
    'token_used_0057',
    now() + interval '1 day',
    now() - interval '1 hour'
  ),
  (
    '57400000-0000-4000-8000-000000000005',
    '57100000-0000-4000-8000-000000000001',
    'expired-0057@example.test',
    'staff',
    '57000000-0000-4000-8000-000000000001',
    'token_expired_0057',
    now() - interval '1 minute',
    null
  ),
  (
    '57400000-0000-4000-8000-000000000006',
    '57100000-0000-4000-8000-000000000001',
    'state-0057@example.test',
    'manager',
    '57000000-0000-4000-8000-000000000001',
    'token_state_0057',
    now() + interval '1 day',
    null
  ),
  (
    '57400000-0000-4000-8000-000000000007',
    '57100000-0000-4000-8000-000000000001',
    'rollback-0057@example.test',
    'staff',
    '57000000-0000-4000-8000-000000000001',
    'token_rollback_0057',
    now() + interval '1 day',
    null
  );

-- Functions are caller-authenticated definer boundaries with empty search paths.
do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.open_bottle_from_inventory(uuid,uuid)',
    'public.accept_invitation_idempotent(text,text,text)'
  ]
  loop
    if has_function_privilege('anon', v_signature, 'EXECUTE') then
      raise exception 'anon retains execute on %', v_signature;
    end if;
    if not has_function_privilege(
      'authenticated',
      v_signature,
      'EXECUTE'
    ) then
      raise exception 'authenticated lacks execute on %', v_signature;
    end if;
  end loop;

  if exists (
    select 1
    from pg_proc
    where oid in (
      to_regprocedure(
        'public.open_bottle_from_inventory(uuid,uuid)'
      ),
      to_regprocedure(
        'public.accept_invitation_idempotent(text,text,text)'
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
    raise exception '0057 function lacks SECURITY DEFINER empty search_path';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.invitations'::regclass
      and conname = 'invitations_invitable_role_check'
      and contype = 'c'
      and convalidated
  ) then
    raise exception 'invitable-role constraint is missing or unvalidated';
  end if;
end;
$$;

select pg_temp.expect_failure(
  $sql$
    insert into public.invitations (
      restaurant_id,
      email,
      role,
      invited_by,
      token
    ) values (
      '57100000-0000-4000-8000-000000000001',
      'forbidden-owner-0057@example.test',
      'owner',
      '57000000-0000-4000-8000-000000000001',
      'token_forbidden_owner_0057'
    )
  $sql$,
  '23514'
);

-- An authenticated role without a JWT identity cannot enter either boundary.
select set_config('request.jwt.claim.sub', '', true);
set local role authenticated;

select pg_temp.expect_failure(
  $sql$
    select * from public.open_bottle_from_inventory(
      '57100000-0000-4000-8000-000000000001',
      '57200000-0000-4000-8000-000000000001'
    )
  $sql$,
  '42501'
);

select pg_temp.expect_failure(
  $sql$
    select * from public.accept_invitation_idempotent(
      'token_accept_0057',
      'unauth_key_0057',
      repeat('a', 64)
    )
  $sql$,
  '42501'
);

reset role;

-- A staff member opens one sealed unit. The oldest source row is selected,
-- the public response is complete, and no pour ledger event is created.
select set_config(
  'request.jwt.claim.sub',
  '57000000-0000-4000-8000-000000000002',
  true
);
set local role authenticated;

do $$
declare
  v_result record;
  v_bottle public.open_bottles%rowtype;
begin
  select * into v_result
  from public.open_bottle_from_inventory(
    '57100000-0000-4000-8000-000000000001',
    '57200000-0000-4000-8000-000000000001'
  );

  if v_result.outcome <> 'opened'
     or v_result.bottle_id is null
     or v_result.wine_id
          <> '57200000-0000-4000-8000-000000000001'
     or v_result.remaining_ml <> 750
     or v_result.opened_at is null then
    raise exception 'fresh bottle result is malformed: %',
      row_to_json(v_result);
  end if;

  select * into strict v_bottle
  from public.open_bottles
  where id = v_result.bottle_id;

  if v_bottle.wine_id
       <> '57200000-0000-4000-8000-000000000001'
     or v_bottle.restaurant_id
          <> '57100000-0000-4000-8000-000000000001'
     or v_bottle.remaining_ml <> 750
     or v_bottle.opened_by
          <> '57000000-0000-4000-8000-000000000002'
     or v_bottle.source_inventory_item_id
          <> '57300000-0000-4000-8000-000000000001'
     or v_bottle.closed_at is not null then
    raise exception 'fresh bottle state is malformed: %',
      row_to_json(v_bottle);
  end if;

  if (
    select quantity
    from public.inventory_items
    where id = '57300000-0000-4000-8000-000000000001'
  ) <> 1 or (
    select quantity
    from public.inventory_items
    where id = '57300000-0000-4000-8000-000000000002'
  ) <> 2 then
    raise exception 'oldest sealed inventory was not decremented exactly once';
  end if;

  if exists (
    select 1
    from public.pour_events
    where wine_id = '57200000-0000-4000-8000-000000000001'
  ) then
    raise exception 'manual open created a pour event';
  end if;
end;
$$;

-- A closed singleton row is reopened in place with its new sealed source.
do $$
declare
  v_result record;
  v_bottle public.open_bottles%rowtype;
begin
  select * into v_result
  from public.open_bottle_from_inventory(
    '57100000-0000-4000-8000-000000000001',
    '57200000-0000-4000-8000-000000000005'
  );

  if v_result.outcome <> 'opened'
     or v_result.bottle_id
          <> '57500000-0000-4000-8000-000000000001'
     or v_result.remaining_ml <> 375 then
    raise exception 'closed bottle was not reopened in place: %',
      row_to_json(v_result);
  end if;

  select * into strict v_bottle
  from public.open_bottles
  where id = '57500000-0000-4000-8000-000000000001';

  if v_bottle.closed_at is not null
     or v_bottle.remaining_ml <> 375
     or v_bottle.opened_by
          <> '57000000-0000-4000-8000-000000000002'
     or v_bottle.source_inventory_item_id
          <> '57300000-0000-4000-8000-000000000006'
     or (
       select quantity
       from public.inventory_items
       where id = '57300000-0000-4000-8000-000000000006'
     ) <> 0 then
    raise exception 'reopened bottle state is malformed: %',
      row_to_json(v_bottle);
  end if;

  if exists (
    select 1
    from public.pour_events
    where wine_id = '57200000-0000-4000-8000-000000000005'
  ) then
    raise exception 'manual reopen created a pour event';
  end if;
end;
$$;

-- Missing stock and foreign wines use non-mutating, opaque outcomes.
do $$
declare
  v_result record;
begin
  select * into v_result
  from public.open_bottle_from_inventory(
    '57100000-0000-4000-8000-000000000001',
    '57200000-0000-4000-8000-000000000002'
  );
  if v_result.outcome <> 'no_sealed_stock'
     or v_result.bottle_id is not null
     or v_result.wine_id is not null
     or v_result.remaining_ml is not null
     or v_result.opened_at is not null then
    raise exception 'no-stock result is malformed: %', row_to_json(v_result);
  end if;

  select * into v_result
  from public.open_bottle_from_inventory(
    '57100000-0000-4000-8000-000000000001',
    '57200000-0000-4000-8000-000000000004'
  );
  if v_result.outcome <> 'not_found'
     or v_result.bottle_id is not null
     or v_result.wine_id is not null then
    raise exception 'foreign wine was not opaque: %', row_to_json(v_result);
  end if;

  if exists (
    select 1
    from public.open_bottles
    where wine_id in (
      '57200000-0000-4000-8000-000000000002',
      '57200000-0000-4000-8000-000000000004'
    )
  ) then
    raise exception 'non-opening outcome mutated open bottles';
  end if;
end;
$$;

select pg_temp.expect_failure(
  $sql$
    select * from public.open_bottle_from_inventory(
      '57100000-0000-4000-8000-000000000002',
      '57200000-0000-4000-8000-000000000004'
    )
  $sql$,
  '42501'
);

reset role;

-- An arbitrary authenticated non-member cannot mutate restaurant A.
select set_config(
  'request.jwt.claim.sub',
  '57000000-0000-4000-8000-000000000003',
  true
);
set local role authenticated;

select pg_temp.expect_failure(
  $sql$
    select * from public.open_bottle_from_inventory(
      '57100000-0000-4000-8000-000000000001',
      '57200000-0000-4000-8000-000000000001'
    )
  $sql$,
  '42501'
);

reset role;

-- Force the last open-bottle write to fail. The preceding inventory decrement
-- must roll back with the function transaction.
create or replace function pg_temp.reject_atomic_write()
returns trigger
language plpgsql
as $$
begin
  raise exception using
    errcode = 'XX000',
    message = 'induced 0057 atomic write failure';
end;
$$;

create trigger reject_0057_open_bottle
before insert or update on public.open_bottles
for each row
when (
  new.wine_id = '57200000-0000-4000-8000-000000000003'::uuid
)
execute function pg_temp.reject_atomic_write();

select set_config(
  'request.jwt.claim.sub',
  '57000000-0000-4000-8000-000000000002',
  true
);
set local role authenticated;

select pg_temp.expect_failure(
  $sql$
    select * from public.open_bottle_from_inventory(
      '57100000-0000-4000-8000-000000000001',
      '57200000-0000-4000-8000-000000000003'
    )
  $sql$,
  'XX000'
);

reset role;
drop trigger reject_0057_open_bottle on public.open_bottles;

do $$
begin
  if (
    select quantity
    from public.inventory_items
    where id = '57300000-0000-4000-8000-000000000004'
  ) <> 1 then
    raise exception 'failed open leaked its sealed-inventory decrement';
  end if;

  if exists (
    select 1
    from public.open_bottles
    where wine_id = '57200000-0000-4000-8000-000000000003'
  ) then
    raise exception 'failed open leaked an open-bottle row';
  end if;
end;
$$;

-- A non-member can atomically accept an email-bound invitation. The exact
-- result is cached without storing the invitation token or email.
select set_config(
  'request.jwt.claim.sub',
  '57000000-0000-4000-8000-000000000004',
  true
);
set local role authenticated;

do $$
declare
  v_result record;
  v_expected jsonb := jsonb_build_object(
    'success', true,
    'role', 'staff',
    'restaurantId', '57100000-0000-4000-8000-000000000001'::uuid
  );
begin
  select * into v_result
  from public.accept_invitation_idempotent(
    'token_accept_0057',
    'invite_accept_key_0057',
    repeat('a', 64)
  );

  if v_result.outcome <> 'accepted'
     or v_result.response_status <> 200
     or v_result.response_body <> v_expected
     or v_result.replayed then
    raise exception 'fresh invitation acceptance is malformed: %',
      row_to_json(v_result);
  end if;
end;
$$;

reset role;

do $$
declare
  v_claim public.api_idempotency%rowtype;
  v_accepted_at timestamptz;
begin
  select accepted_at into v_accepted_at
  from public.invitations
  where id = '57400000-0000-4000-8000-000000000001';
  if v_accepted_at is null then
    raise exception 'accepted invitation lacks accepted_at';
  end if;
  perform set_config('test.accepted_at', v_accepted_at::text, true);

  if (
    select count(*)
    from public.memberships
    where user_id = '57000000-0000-4000-8000-000000000004'
      and restaurant_id = '57100000-0000-4000-8000-000000000001'
      and role = 'staff'
  ) <> 1 then
    raise exception 'non-member acceptance did not create one staff membership';
  end if;

  select * into strict v_claim
  from public.api_idempotency
  where user_id = '57000000-0000-4000-8000-000000000004'
    and idempotency_key = 'invite_accept_key_0057';

  if v_claim.restaurant_id
       <> '57100000-0000-4000-8000-000000000001'
     or v_claim.operation_id <> 'api:POST:/api/team/accept-invite'
     or v_claim.request_hash <> repeat('a', 64)
     or v_claim.state <> 'completed'
     or v_claim.response_status <> 200
     or v_claim.response_headers <> '{}'::jsonb
     or v_claim.completed_at is null
     or v_claim.response_body::text like '%token_accept_0057%'
     or v_claim.response_body::text ilike '%invitee-0057@example.test%' then
    raise exception 'accepted idempotency claim is malformed: %',
      row_to_json(v_claim);
  end if;
end;
$$;

set local role authenticated;

do $$
declare
  v_replay record;
  v_expected jsonb := jsonb_build_object(
    'success', true,
    'role', 'staff',
    'restaurantId', '57100000-0000-4000-8000-000000000001'::uuid
  );
begin
  select * into v_replay
  from public.accept_invitation_idempotent(
    'token_accept_0057',
    'invite_accept_key_0057',
    repeat('a', 64)
  );

  if v_replay.outcome <> 'replay'
     or v_replay.response_status <> 200
     or v_replay.response_body <> v_expected
     or not v_replay.replayed then
    raise exception 'accepted response did not replay exactly: %',
      row_to_json(v_replay);
  end if;
end;
$$;

reset role;

do $$
begin
  if (
    select accepted_at
    from public.invitations
    where id = '57400000-0000-4000-8000-000000000001'
  ) <> current_setting('test.accepted_at')::timestamptz then
    raise exception 'replay mutated invitation acceptance time';
  end if;
end;
$$;

-- An existing owner accepts a staff invitation without role demotion.
select set_config(
  'request.jwt.claim.sub',
  '57000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;

do $$
declare
  v_result record;
  v_expected jsonb := jsonb_build_object(
    'success', true,
    'message', 'You are already a member of this restaurant.',
    'restaurantId', '57100000-0000-4000-8000-000000000001'::uuid
  );
begin
  select * into v_result
  from public.accept_invitation_idempotent('token_existing_0057');

  if v_result.outcome <> 'accepted'
     or v_result.response_status <> 200
     or v_result.response_body <> v_expected
     or v_result.replayed then
    raise exception 'existing-member acceptance is malformed: %',
      row_to_json(v_result);
  end if;
end;
$$;

reset role;

do $$
begin
  if (
    select role
    from public.memberships
    where user_id = '57000000-0000-4000-8000-000000000001'
      and restaurant_id = '57100000-0000-4000-8000-000000000001'
  ) <> 'owner'::public.membership_role then
    raise exception 'existing owner was demoted by invitation acceptance';
  end if;

  if (
    select accepted_at
    from public.invitations
    where id = '57400000-0000-4000-8000-000000000002'
  ) is null then
    raise exception 'existing-member invitation was not consumed';
  end if;
end;
$$;

-- Wrong-recipient and missing tokens are exactly the same opaque 404, and
-- neither creates an idempotency binding before the invitation is identified.
select set_config(
  'request.jwt.claim.sub',
  '57000000-0000-4000-8000-000000000003',
  true
);
set local role authenticated;

do $$
declare
  v_mismatch record;
  v_missing record;
  v_expected jsonb := jsonb_build_object(
    'error',
    jsonb_build_object(
      'code', 'not_found',
      'message', 'Invalid or expired invitation.'
    )
  );
begin
  select * into v_mismatch
  from public.accept_invitation_idempotent(
    'token_mismatch_0057',
    'opaque_mismatch_key_0057',
    repeat('1', 64)
  );
  select * into v_missing
  from public.accept_invitation_idempotent(
    'token_missing_0057',
    'opaque_missing_key_0057',
    repeat('2', 64)
  );

  if v_mismatch.outcome <> 'not_found'
     or v_mismatch.response_status <> 404
     or v_mismatch.response_body <> v_expected
     or v_mismatch.replayed
     or v_missing.outcome <> v_mismatch.outcome
     or v_missing.response_status <> v_mismatch.response_status
     or v_missing.response_body <> v_mismatch.response_body
     or v_missing.replayed then
    raise exception 'invitation mismatch is not exactly opaque: %, %',
      row_to_json(v_mismatch),
      row_to_json(v_missing);
  end if;
end;
$$;

reset role;

do $$
begin
  if exists (
    select 1
    from public.api_idempotency
    where user_id = '57000000-0000-4000-8000-000000000003'
      and idempotency_key in (
        'opaque_mismatch_key_0057',
        'opaque_missing_key_0057'
      )
  ) then
    raise exception 'opaque invitation miss left an idempotency binding';
  end if;

  if (
    select accepted_at
    from public.invitations
    where id = '57400000-0000-4000-8000-000000000003'
  ) is not null then
    raise exception 'wrong recipient consumed an invitation';
  end if;
end;
$$;

-- Already-used and expired invitations return and cache their exact legacy
-- compatibility errors without creating memberships.
select set_config(
  'request.jwt.claim.sub',
  '57000000-0000-4000-8000-000000000005',
  true
);
set local role authenticated;

do $$
declare
  v_result record;
  v_replay record;
  v_expected jsonb := jsonb_build_object(
    'error',
    jsonb_build_object(
      'code', 'bad_request',
      'message', 'This invitation has already been used.'
    )
  );
begin
  select * into v_result
  from public.accept_invitation_idempotent(
    'token_used_0057',
    'invite_used_key_0057',
    repeat('b', 64)
  );
  if v_result.outcome <> 'already_used'
     or v_result.response_status <> 400
     or v_result.response_body <> v_expected
     or v_result.replayed then
    raise exception 'already-used response is malformed: %',
      row_to_json(v_result);
  end if;

  select * into v_replay
  from public.accept_invitation_idempotent(
    'token_used_0057',
    'invite_used_key_0057',
    repeat('b', 64)
  );
  if v_replay.outcome <> 'replay'
     or v_replay.response_status <> 400
     or v_replay.response_body <> v_expected
     or not v_replay.replayed then
    raise exception 'already-used response did not replay: %',
      row_to_json(v_replay);
  end if;
end;
$$;

reset role;

select set_config(
  'request.jwt.claim.sub',
  '57000000-0000-4000-8000-000000000006',
  true
);
set local role authenticated;

do $$
declare
  v_result record;
  v_replay record;
  v_expected jsonb := jsonb_build_object(
    'error',
    jsonb_build_object(
      'code', 'bad_request',
      'message', 'This invitation has expired.'
    )
  );
begin
  select * into v_result
  from public.accept_invitation_idempotent(
    'token_expired_0057',
    'invite_expired_key_0057',
    repeat('c', 64)
  );
  if v_result.outcome <> 'invitation_expired'
     or v_result.response_status <> 400
     or v_result.response_body <> v_expected
     or v_result.replayed then
    raise exception 'expired invitation response is malformed: %',
      row_to_json(v_result);
  end if;

  select * into v_replay
  from public.accept_invitation_idempotent(
    'token_expired_0057',
    'invite_expired_key_0057',
    repeat('c', 64)
  );
  if v_replay.outcome <> 'replay'
     or v_replay.response_status <> 400
     or v_replay.response_body <> v_expected
     or not v_replay.replayed then
    raise exception 'expired invitation response did not replay: %',
      row_to_json(v_replay);
  end if;
end;
$$;

reset role;

do $$
begin
  if exists (
    select 1
    from public.memberships
    where user_id in (
      '57000000-0000-4000-8000-000000000005',
      '57000000-0000-4000-8000-000000000006'
    )
      and restaurant_id = '57100000-0000-4000-8000-000000000001'
  ) then
    raise exception 'used or expired invitation created a membership';
  end if;

  if (
    select accepted_at
    from public.invitations
    where id = '57400000-0000-4000-8000-000000000005'
  ) is not null then
    raise exception 'expired invitation was consumed';
  end if;
end;
$$;

-- Seed exact key bindings for reuse, in-progress, expired, and unknown
-- classifications. These paths must short-circuit before invitation mutation.
insert into public.api_idempotency (
  restaurant_id,
  user_id,
  operation_id,
  idempotency_key,
  request_hash,
  state,
  created_at,
  updated_at
) values
  (
    '57100000-0000-4000-8000-000000000001',
    '57000000-0000-4000-8000-000000000007',
    'api:POST:/api/team/accept-invite',
    'invite_reuse_key_0057',
    repeat('d', 64),
    'in_progress',
    now(),
    now()
  ),
  (
    '57100000-0000-4000-8000-000000000001',
    '57000000-0000-4000-8000-000000000007',
    'api:POST:/api/team/accept-invite',
    'invite_progress_key_0057',
    repeat('f', 64),
    'in_progress',
    now(),
    now()
  ),
  (
    '57100000-0000-4000-8000-000000000001',
    '57000000-0000-4000-8000-000000000007',
    'api:POST:/api/team/accept-invite',
    'invite_key_expired_0057',
    repeat('7', 64),
    'in_progress',
    now() - interval '24 hours 30 minutes',
    now() - interval '24 hours 30 minutes'
  ),
  (
    '57100000-0000-4000-8000-000000000001',
    '57000000-0000-4000-8000-000000000007',
    'api:POST:/api/team/accept-invite',
    'invite_unknown_key_0057',
    repeat('8', 64),
    'failed_unknown',
    now(),
    now()
  );

select set_config(
  'request.jwt.claim.sub',
  '57000000-0000-4000-8000-000000000007',
  true
);
set local role authenticated;

do $$
declare
  v_result record;
begin
  select * into v_result
  from public.accept_invitation_idempotent(
    'token_state_0057',
    'invite_reuse_key_0057',
    repeat('e', 64)
  );
  if v_result.outcome <> 'idempotency_key_reused'
     or v_result.response_status <> 409
     or v_result.response_body #>> '{error,code}'
          <> 'idempotency_key_reused'
     or v_result.replayed then
    raise exception 'key reuse classification is malformed: %',
      row_to_json(v_result);
  end if;

  select * into v_result
  from public.accept_invitation_idempotent(
    'token_state_0057',
    'invite_progress_key_0057',
    repeat('f', 64)
  );
  if v_result.outcome <> 'idempotency_in_progress'
     or v_result.response_status <> 409
     or v_result.response_body #>> '{error,code}'
          <> 'idempotency_in_progress'
     or v_result.replayed then
    raise exception 'in-progress classification is malformed: %',
      row_to_json(v_result);
  end if;

  select * into v_result
  from public.accept_invitation_idempotent(
    'token_state_0057',
    'invite_key_expired_0057',
    repeat('7', 64)
  );
  if v_result.outcome <> 'idempotency_key_expired'
     or v_result.response_status <> 409
     or v_result.response_body #>> '{error,code}'
          <> 'idempotency_key_expired'
     or v_result.replayed then
    raise exception 'expired-key classification is malformed: %',
      row_to_json(v_result);
  end if;

  select * into v_result
  from public.accept_invitation_idempotent(
    'token_state_0057',
    'invite_unknown_key_0057',
    repeat('8', 64)
  );
  if v_result.outcome <> 'idempotency_outcome_unknown'
     or v_result.response_status <> 409
     or v_result.response_body #>> '{error,code}'
          <> 'idempotency_outcome_unknown'
     or v_result.replayed then
    raise exception 'unknown-outcome classification is malformed: %',
      row_to_json(v_result);
  end if;
end;
$$;

reset role;

do $$
begin
  if (
    select accepted_at
    from public.invitations
    where id = '57400000-0000-4000-8000-000000000006'
  ) is not null or exists (
    select 1
    from public.memberships
    where user_id = '57000000-0000-4000-8000-000000000007'
      and restaurant_id = '57100000-0000-4000-8000-000000000001'
  ) then
    raise exception 'idempotency classification mutated invitation state';
  end if;
end;
$$;

-- Force idempotency completion to fail after invitation and membership writes.
-- All three effects, including the initial claim, must roll back together.
create trigger reject_0057_invitation_completion
before update on public.api_idempotency
for each row
when (new.idempotency_key = 'invite_rollback_key_0057')
execute function pg_temp.reject_atomic_write();

select set_config(
  'request.jwt.claim.sub',
  '57000000-0000-4000-8000-000000000008',
  true
);
set local role authenticated;

select pg_temp.expect_failure(
  $sql$
    select * from public.accept_invitation_idempotent(
      'token_rollback_0057',
      'invite_rollback_key_0057',
      repeat('9', 64)
    )
  $sql$,
  'XX000'
);

reset role;
drop trigger reject_0057_invitation_completion on public.api_idempotency;

do $$
begin
  if exists (
    select 1
    from public.memberships
    where user_id = '57000000-0000-4000-8000-000000000008'
      and restaurant_id = '57100000-0000-4000-8000-000000000001'
  ) then
    raise exception 'failed invitation acceptance leaked a membership';
  end if;

  if (
    select accepted_at
    from public.invitations
    where id = '57400000-0000-4000-8000-000000000007'
  ) is not null then
    raise exception 'failed invitation acceptance consumed the invitation';
  end if;

  if exists (
    select 1
    from public.api_idempotency
    where user_id = '57000000-0000-4000-8000-000000000008'
      and idempotency_key = 'invite_rollback_key_0057'
  ) then
    raise exception 'failed invitation acceptance leaked its claim';
  end if;
end;
$$;

-- The general cleanup still removes only rows beyond the 25-hour window.
insert into public.api_idempotency (
  restaurant_id,
  user_id,
  operation_id,
  idempotency_key,
  request_hash,
  state,
  response_status,
  response_headers,
  response_body,
  created_at,
  updated_at,
  completed_at
) values (
  '57100000-0000-4000-8000-000000000001',
  '57000000-0000-4000-8000-000000000007',
  'api:POST:/api/team/accept-invite',
  'invite_cleanup_key_0057',
  repeat('6', 64),
  'completed',
  200,
  '{}'::jsonb,
  '{"success":true}'::jsonb,
  now() - interval '25 hours 1 minute',
  now() - interval '25 hours 1 minute',
  now() - interval '25 hours 1 minute'
);

do $$
begin
  perform public.cleanup_api_idempotency();

  if exists (
    select 1
    from public.api_idempotency
    where idempotency_key = 'invite_cleanup_key_0057'
  ) then
    raise exception 'cleanup retained an accept row older than 25 hours';
  end if;

  if not exists (
    select 1
    from public.api_idempotency
    where idempotency_key = 'invite_key_expired_0057'
  ) then
    raise exception 'cleanup removed an observable 24-hour expired key early';
  end if;

  if exists (
    select 1
    from public.api_idempotency
    where operation_id = 'api:POST:/api/team/accept-invite'
      and (
        coalesce(response_body::text, '') like '%token_%'
        or coalesce(response_body::text, '')
             ilike '%@example.test%'
        or coalesce(response_headers::text, '') like '%token_%'
        or request_hash !~ '^[0-9a-f]{64}$'
      )
  ) then
    raise exception 'accept idempotency storage contains a token, email, or malformed hash';
  end if;
end;
$$;

rollback;

select '0057 atomic idempotent commands acceptance passed' as result;
