-- Focused acceptance for 0065_invoice_scan_commit_idempotency.sql.
-- Run only against an isolated database with migrations through 0065:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -v dblink_conn="$DATABASE_URL" \
--     -f supabase/tests/0065_invoice_scan_commit_idempotency.sql

\if :{?dblink_conn}
\else
\echo '0065 acceptance requires -v dblink_conn=<password-authenticated database URL>'
\quit 2
\endif

create extension if not exists dblink with schema extensions;

drop trigger if exists reject_scan_commit_completion_0065
  on public.api_idempotency;
drop trigger if exists delay_scan_commit_completion_0065
  on public.api_idempotency;
drop function if exists public.reject_scan_commit_completion_0065();
drop function if exists public.delay_scan_commit_completion_0065();

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
  '64200000-0000-4000-8000-000000000001',
  '64200000-0000-4000-8000-000000000002'
);
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
    'scan-staff-a-0065@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '64000000-0000-4000-8000-000000000002',
    'scan-staff-b-0065@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '64000000-0000-4000-8000-000000000003',
    'scan-nonmember-0065@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

insert into public.restaurants (id, name) values
  (
    '64200000-0000-4000-8000-000000000001',
    'Scan Commit Restaurant A'
  ),
  (
    '64200000-0000-4000-8000-000000000002',
    'Scan Commit Restaurant B'
  );

insert into public.memberships (
  id,
  user_id,
  restaurant_id,
  role
) values
  (
    '64300000-0000-4000-8000-000000000001',
    '64000000-0000-4000-8000-000000000001',
    '64200000-0000-4000-8000-000000000001',
    'staff'
  ),
  (
    '64300000-0000-4000-8000-000000000002',
    '64000000-0000-4000-8000-000000000002',
    '64200000-0000-4000-8000-000000000002',
    'staff'
  );

insert into public.invoice_scans (
  id,
  restaurant_id,
  distributor_name,
  parsed_line_items,
  final_line_items,
  item_count
) values
  (
    '64100000-0000-4000-8000-000000000001',
    '64200000-0000-4000-8000-000000000001',
    'Replay Importer',
    '[]'::jsonb,
    '[
      {
        "id": "line-a",
        "name": "Barolo",
        "producer": "Replay Producer",
        "vintage": 2019,
        "varietal": "Nebbiolo",
        "region": "Piedmont",
        "qty": 2,
        "unitCost": 95,
        "currency": "EUR",
        "format": "1.5L",
        "confidence": 0.98
      },
      {
        "id": "line-b",
        "name": "Barolo",
        "producer": "Replay Producer",
        "vintage": 2019,
        "varietal": "Nebbiolo",
        "region": "Piedmont",
        "qty": 1,
        "unitCost": 48,
        "currency": "EUR",
        "format": null,
        "confidence": 0.94,
        "lowFields": ["format"]
      }
    ]'::jsonb,
    2
  ),
  (
    '64100000-0000-4000-8000-000000000002',
    '64200000-0000-4000-8000-000000000001',
    'Invalid Importer',
    '[]'::jsonb,
    '[{"id":"invalid","qty":1.5}]'::jsonb,
    1
  ),
  (
    '64100000-0000-4000-8000-000000000003',
    '64200000-0000-4000-8000-000000000001',
    'Concurrent Importer',
    '[]'::jsonb,
    '[
      {
        "id": "line-concurrent",
        "name": "Concurrent Rioja",
        "producer": "Concurrent Producer",
        "vintage": 2020,
        "varietal": "Tempranillo",
        "region": "Rioja",
        "qty": 3,
        "unitCost": 27.5,
        "currency": "USD",
        "format": "750ml",
        "confidence": 0.99
      }
    ]'::jsonb,
    1
  ),
  (
    '64100000-0000-4000-8000-000000000004',
    '64200000-0000-4000-8000-000000000001',
    'Rollback Importer',
    '[]'::jsonb,
    '[
      {
        "id": "line-rollback",
        "name": "Rollback Riesling",
        "producer": "Rollback Producer",
        "vintage": 2021,
        "varietal": "Riesling",
        "region": "Mosel",
        "qty": 4,
        "unitCost": 31,
        "currency": "EUR",
        "format": null,
        "confidence": 0.97
      }
    ]'::jsonb,
    1
  ),
  (
    '64100000-0000-4000-8000-000000000099',
    '64200000-0000-4000-8000-000000000002',
    'Foreign Importer',
    '[]'::jsonb,
    '[
      {
        "id": "line-foreign",
        "name": "Foreign Wine",
        "producer": "Foreign Producer",
        "vintage": null,
        "varietal": "",
        "region": "",
        "qty": 1,
        "unitCost": 10,
        "currency": null,
        "format": null,
        "confidence": 1
      }
    ]'::jsonb,
    1
  );

-- Privileges and the execution context are exact.
do $$
begin
  if has_function_privilege(
    'anon',
    'public.commit_invoice_scan_idempotent(uuid,uuid,text,text)',
    'EXECUTE'
  ) then
    raise exception 'anon retains invoice scan commit execution';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.commit_invoice_scan_idempotent(uuid,uuid,text,text)',
    'EXECUTE'
  ) then
    raise exception 'authenticated lacks invoice scan commit execution';
  end if;

  if exists (
    select 1
    from pg_proc
    where oid = to_regprocedure(
      'public.commit_invoice_scan_idempotent(uuid,uuid,text,text)'
    )
      and (
        not prosecdef
        or not (
          coalesce(proconfig, '{}'::text[])
          @> array['search_path=""']::text[]
        )
      )
  ) then
    raise exception 'invoice scan commit context is not hardened';
  end if;
end;
$$;

-- Authentication and tenant membership are enforced in the database.
select set_config('request.jwt.claim.sub', '', false);
set role authenticated;
select pg_temp.expect_failure(
  $sql$
    select * from public.commit_invoice_scan_idempotent(
      '64200000-0000-4000-8000-000000000001',
      '64100000-0000-4000-8000-000000000001'
    )
  $sql$,
  '42501'
);
reset role;

select set_config(
  'request.jwt.claim.sub',
  '64000000-0000-4000-8000-000000000003',
  false
);
set role authenticated;
select pg_temp.expect_failure(
  $sql$
    select * from public.commit_invoice_scan_idempotent(
      '64200000-0000-4000-8000-000000000001',
      '64100000-0000-4000-8000-000000000001'
    )
  $sql$,
  '42501'
);
reset role;

select set_config(
  'request.jwt.claim.sub',
  '64000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;
select pg_temp.expect_failure(
  $sql$
    select * from public.commit_invoice_scan_idempotent(
      '64200000-0000-4000-8000-000000000002',
      '64100000-0000-4000-8000-000000000099'
    )
  $sql$,
  '42501'
);
reset role;

-- A false route hash is rejected before any claim or inventory mutation.
select set_config(
  'request.jwt.claim.sub',
  '64000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;
select pg_temp.expect_failure(
  $sql$
    select * from public.commit_invoice_scan_idempotent(
      '64200000-0000-4000-8000-000000000001',
      '64100000-0000-4000-8000-000000000001',
      'false_hash_key_0065',
      repeat('a', 64)
    )
  $sql$,
  '22023'
);
reset role;

do $$
begin
  if exists (
    select 1 from public.api_idempotency
    where idempotency_key = 'false_hash_key_0065'
  ) or exists (
    select 1 from public.inventory_items
    where invoice_scan_id = '64100000-0000-4000-8000-000000000001'
  ) then
    raise exception 'false scan hash created a claim or inventory';
  end if;
end;
$$;

-- Keyless compatibility is still one database transaction and creates no
-- generalized idempotency record.
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
  from public.commit_invoice_scan_idempotent(
    '64200000-0000-4000-8000-000000000001',
    '64100000-0000-4000-8000-000000000001'
  );

  if v_result.outcome <> 'committed'
     or v_result.response_status <> 200
     or v_result.response_body <> '{
       "scanId":"64100000-0000-4000-8000-000000000001",
       "itemCount":2,
       "wineCount":1
     }'::jsonb
     or v_result.replayed
     or cardinality(v_result.wine_ids) <> 2 then
    raise exception 'keyless scan commit response malformed: %',
      row_to_json(v_result);
  end if;
end;
$$;
reset role;

do $$
begin
  if (
    select count(*)
    from public.inventory_items
    where invoice_scan_id = '64100000-0000-4000-8000-000000000001'
  ) <> 2 or exists (
    select 1
    from public.api_idempotency
    where user_id = '64000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'keyless scan commit side effects are incoherent';
  end if;
end;
$$;

delete from public.inventory_items
where invoice_scan_id = '64100000-0000-4000-8000-000000000001';

-- One key executes once and replays the exact stored status/body.
select set_config(
  'request.jwt.claim.sub',
  '64000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;
do $$
declare
  v_fresh record;
  v_replay record;
begin
  select * into v_fresh
  from public.commit_invoice_scan_idempotent(
    '64200000-0000-4000-8000-000000000001',
    '64100000-0000-4000-8000-000000000001',
    'scan_replay_key_0065',
    'c8e48aad60200627c65fe378e4ca622ddf0587bd5383eaca936bd009287914fd'
  );
  select * into v_replay
  from public.commit_invoice_scan_idempotent(
    '64200000-0000-4000-8000-000000000001',
    '64100000-0000-4000-8000-000000000001',
    'scan_replay_key_0065',
    'c8e48aad60200627c65fe378e4ca622ddf0587bd5383eaca936bd009287914fd'
  );

  if v_fresh.outcome <> 'committed'
     or v_replay.outcome <> 'replay'
     or not v_replay.replayed
     or v_fresh.response_status <> v_replay.response_status
     or v_fresh.response_body <> v_replay.response_body
     or v_replay.wine_ids is not null then
    raise exception 'keyed scan replay was not exact: %, %',
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
    from public.inventory_items
    where invoice_scan_id = '64100000-0000-4000-8000-000000000001'
  ) <> 2 or (
    select state
    from public.api_idempotency
    where user_id = '64000000-0000-4000-8000-000000000001'
      and idempotency_key = 'scan_replay_key_0065'
  ) <> 'completed' then
    raise exception 'keyed replay duplicated inventory or lost its claim';
  end if;
end;
$$;

-- The key cannot be rebound to another scan, while a foreign scan under the
-- selected tenant remains indistinguishable from a missing scan.
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
  from public.commit_invoice_scan_idempotent(
    '64200000-0000-4000-8000-000000000001',
    '64100000-0000-4000-8000-000000000002',
    'scan_replay_key_0065',
    '73157a6a09a3f7ee4afb352b9da35039a18c579fcc19cd9152c6fcb3cd1c7445'
  );
  if v_result.outcome <> 'idempotency_key_reused'
     or v_result.response_status <> 409 then
    raise exception 'changed scan reused a bound key: %',
      row_to_json(v_result);
  end if;

  select * into v_result
  from public.commit_invoice_scan_idempotent(
    '64200000-0000-4000-8000-000000000001',
    '64100000-0000-4000-8000-000000000099'
  );
  if v_result.outcome <> 'not_found'
     or v_result.response_status <> 404 then
    raise exception 'foreign scan leaked through tenant boundary';
  end if;
end;
$$;
reset role;

-- Invalid persisted line items are a deterministic, stored 400 and never
-- create inventory.
select set_config(
  'request.jwt.claim.sub',
  '64000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;
do $$
declare
  v_fresh record;
  v_replay record;
begin
  select * into v_fresh
  from public.commit_invoice_scan_idempotent(
    '64200000-0000-4000-8000-000000000001',
    '64100000-0000-4000-8000-000000000002',
    'invalid_scan_key_0065',
    '73157a6a09a3f7ee4afb352b9da35039a18c579fcc19cd9152c6fcb3cd1c7445'
  );
  select * into v_replay
  from public.commit_invoice_scan_idempotent(
    '64200000-0000-4000-8000-000000000001',
    '64100000-0000-4000-8000-000000000002',
    'invalid_scan_key_0065',
    '73157a6a09a3f7ee4afb352b9da35039a18c579fcc19cd9152c6fcb3cd1c7445'
  );

  if v_fresh.outcome <> 'invalid_scan'
     or v_fresh.response_status <> 400
     or v_fresh.response_body #>> '{error,message}'
          <> 'Scan has no valid line items to commit.'
     or v_replay.outcome <> 'replay'
     or v_replay.response_body <> v_fresh.response_body then
    raise exception 'invalid scan response was not stored exactly';
  end if;
end;
$$;
reset role;

do $$
begin
  if exists (
    select 1 from public.inventory_items
    where invoice_scan_id = '64100000-0000-4000-8000-000000000002'
  ) then
    raise exception 'invalid scan created inventory';
  end if;
end;
$$;

-- Failure while storing the response rolls back wines, inventory, and claim.
create or replace function public.reject_scan_commit_completion_0065()
returns trigger
language plpgsql
as $$
begin
  raise exception using
    errcode = 'XX000',
    message = 'induced 0065 idempotency completion failure';
end;
$$;

create trigger reject_scan_commit_completion_0065
before update on public.api_idempotency
for each row
when (new.idempotency_key = 'scan_rollback_key_0065')
execute function public.reject_scan_commit_completion_0065();

select set_config(
  'request.jwt.claim.sub',
  '64000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;
select pg_temp.expect_failure(
  $sql$
    select * from public.commit_invoice_scan_idempotent(
      '64200000-0000-4000-8000-000000000001',
      '64100000-0000-4000-8000-000000000004',
      'scan_rollback_key_0065',
      '3096c4bd5d78eafcf3af18fa67c74335b4f4d80709a18d74818c41976c870b97'
    )
  $sql$,
  'XX000'
);
reset role;

drop trigger reject_scan_commit_completion_0065
  on public.api_idempotency;

do $$
begin
  if exists (
    select 1 from public.inventory_items
    where invoice_scan_id = '64100000-0000-4000-8000-000000000004'
  ) or exists (
    select 1 from public.wines
    where restaurant_id = '64200000-0000-4000-8000-000000000001'
      and name = 'Rollback Riesling'
  ) or exists (
    select 1 from public.api_idempotency
    where idempotency_key = 'scan_rollback_key_0065'
  ) then
    raise exception 'completion failure leaked a scan commit effect';
  end if;
end;
$$;

select set_config(
  'request.jwt.claim.sub',
  '64000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;
do $$
declare
  v_fresh record;
  v_replay record;
begin
  select * into v_fresh
  from public.commit_invoice_scan_idempotent(
    '64200000-0000-4000-8000-000000000001',
    '64100000-0000-4000-8000-000000000004',
    'scan_rollback_key_0065',
    '3096c4bd5d78eafcf3af18fa67c74335b4f4d80709a18d74818c41976c870b97'
  );
  select * into v_replay
  from public.commit_invoice_scan_idempotent(
    '64200000-0000-4000-8000-000000000001',
    '64100000-0000-4000-8000-000000000004',
    'scan_rollback_key_0065',
    '3096c4bd5d78eafcf3af18fa67c74335b4f4d80709a18d74818c41976c870b97'
  );
  if v_fresh.outcome <> 'committed'
     or v_replay.outcome <> 'replay'
     or v_fresh.response_body <> v_replay.response_body then
    raise exception 'rollback retry did not execute and replay exactly';
  end if;
end;
$$;
reset role;

-- Concurrent delivery of the same key creates one inventory row and returns
-- one fresh result plus one exact replay.
create or replace function public.delay_scan_commit_completion_0065()
returns trigger
language plpgsql
as $$
begin
  perform pg_sleep(0.75);
  return new;
end;
$$;

create trigger delay_scan_commit_completion_0065
before update on public.api_idempotency
for each row
when (new.idempotency_key = 'scan_concurrent_key_0065')
execute function public.delay_scan_commit_completion_0065();

select extensions.dblink_connect('scan_0065_a', :'dblink_conn');
select extensions.dblink_connect('scan_0065_b', :'dblink_conn');
select extensions.dblink_exec(
  'scan_0065_a',
  $sql$
    set "request.jwt.claim.sub" =
      '64000000-0000-4000-8000-000000000001'
  $sql$
);
select extensions.dblink_exec(
  'scan_0065_b',
  $sql$
    set "request.jwt.claim.sub" =
      '64000000-0000-4000-8000-000000000001'
  $sql$
);
select extensions.dblink_exec('scan_0065_a', 'set role authenticated');
select extensions.dblink_exec('scan_0065_b', 'set role authenticated');
select extensions.dblink_send_query(
  'scan_0065_a',
  $sql$
    select row_to_json(result)::text
    from public.commit_invoice_scan_idempotent(
      '64200000-0000-4000-8000-000000000001',
      '64100000-0000-4000-8000-000000000003',
      'scan_concurrent_key_0065',
      'd08e95601c0e90f7512d563faadf3ff3c1f16d1453e091683cb93829982840ae'
    ) as result
  $sql$
);
select extensions.dblink_send_query(
  'scan_0065_b',
  $sql$
    select row_to_json(result)::text
    from public.commit_invoice_scan_idempotent(
      '64200000-0000-4000-8000-000000000001',
      '64100000-0000-4000-8000-000000000003',
      'scan_concurrent_key_0065',
      'd08e95601c0e90f7512d563faadf3ff3c1f16d1453e091683cb93829982840ae'
    ) as result
  $sql$
);

create temporary table scan_0065_concurrency_results (
  payload jsonb not null
);
insert into scan_0065_concurrency_results (payload)
select payload::jsonb
from extensions.dblink_get_result('scan_0065_a')
  as result(payload text);
insert into scan_0065_concurrency_results (payload)
select payload::jsonb
from extensions.dblink_get_result('scan_0065_b')
  as result(payload text);
select extensions.dblink_disconnect('scan_0065_a');
select extensions.dblink_disconnect('scan_0065_b');

drop trigger delay_scan_commit_completion_0065
  on public.api_idempotency;

do $$
declare
  v_fresh jsonb;
  v_replay jsonb;
begin
  if (
    select count(*)
    from scan_0065_concurrency_results
    where payload ->> 'outcome' = 'committed'
  ) <> 1 or (
    select count(*)
    from scan_0065_concurrency_results
    where payload ->> 'outcome' = 'replay'
  ) <> 1 or (
    select count(*)
    from public.inventory_items
    where invoice_scan_id = '64100000-0000-4000-8000-000000000003'
  ) <> 1 then
    raise exception 'same-key concurrency duplicated scan inventory: %',
      (select jsonb_agg(payload) from scan_0065_concurrency_results);
  end if;

  select payload into strict v_fresh
  from scan_0065_concurrency_results
  where payload ->> 'outcome' = 'committed';
  select payload into strict v_replay
  from scan_0065_concurrency_results
  where payload ->> 'outcome' = 'replay';
  if v_fresh -> 'response_body' <> v_replay -> 'response_body'
     or v_fresh ->> 'response_status'
          <> v_replay ->> 'response_status' then
    raise exception 'concurrent scan replay was not exact';
  end if;
end;
$$;

-- The down migration removes only the new RPC; re-forwarding restores it.
\ir ../migrations/down/0065_invoice_scan_commit_idempotency.down.sql

do $$
begin
  if to_regprocedure(
    'public.commit_invoice_scan_idempotent(uuid,uuid,text,text)'
  ) is not null then
    raise exception '0065 down migration retained the scan commit RPC';
  end if;
end;
$$;

\ir ../migrations/0065_invoice_scan_commit_idempotency.sql

do $$
begin
  if to_regprocedure(
    'public.commit_invoice_scan_idempotent(uuid,uuid,text,text)'
  ) is null then
    raise exception '0065 re-forward did not restore the scan commit RPC';
  end if;
end;
$$;

drop function if exists public.reject_scan_commit_completion_0065();
drop function if exists public.delay_scan_commit_completion_0065();
delete from public.restaurants
where id in (
  '64200000-0000-4000-8000-000000000001',
  '64200000-0000-4000-8000-000000000002'
);
delete from auth.users
where id::text like '64000000-0000-4000-8000-00000000000%';

select '0065 invoice scan commit idempotency acceptance passed' as result;
