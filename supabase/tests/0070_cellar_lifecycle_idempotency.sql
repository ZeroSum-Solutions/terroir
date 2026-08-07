-- Focused acceptance for 0070_cellar_lifecycle_idempotency.sql.
-- Run only against an isolated database with migrations through 0070:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f supabase/tests/0070_cellar_lifecycle_idempotency.sql

create or replace function pg_temp.request_hash(p_identity text)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.encode(
    extensions.digest(
      pg_catalog.int8send(
        pg_catalog.octet_length(pg_catalog.convert_to(p_identity, 'UTF8'))::bigint
      ) || pg_catalog.convert_to(p_identity, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
$$;

delete from public.restaurants where id::text like '70100000-0000-4000-8000-00000000000%';
delete from auth.users where id::text like '70000000-0000-4000-8000-00000000000%';

insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('70000000-0000-4000-8000-000000000001', 'manager-0070@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('70000000-0000-4000-8000-000000000002', 'staff-0070@example.test', '{}'::jsonb, '{}'::jsonb, now(), now());
insert into public.restaurants (id, name) values
  ('70100000-0000-4000-8000-000000000001', 'Cellar Idempotency'),
  ('70100000-0000-4000-8000-000000000002', 'Cellar Authorization');
insert into public.memberships (user_id, restaurant_id, role) values
  ('70000000-0000-4000-8000-000000000001', '70100000-0000-4000-8000-000000000001', 'owner'),
  ('70000000-0000-4000-8000-000000000002', '70100000-0000-4000-8000-000000000002', 'staff');

do $$
begin
  if has_function_privilege('anon', 'public.add_cellar_wine_idempotent(uuid,text,text,integer,text,text,text,integer,numeric,text,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.delete_cellar_wine_idempotent(uuid,uuid,text,text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.add_cellar_wine_idempotent(uuid,text,text,integer,text,text,text,integer,numeric,text,text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.delete_cellar_wine_idempotent(uuid,uuid,text,text)', 'EXECUTE') then
    raise exception 'cellar lifecycle RPC grants are incorrect';
  end if;
end;
$$;

-- Staff cannot create inventory even when calling the RPC directly.
select set_config('request.jwt.claim.sub', '70000000-0000-4000-8000-000000000002', false);
set role authenticated;
do $$
begin
  begin
    perform * from public.add_cellar_wine_idempotent(
      '70100000-0000-4000-8000-000000000002', 'Blocked', 'Test', null, null,
      null, null, 1, 0
    );
  exception when sqlstate '42501' then return;
  end;
  raise exception 'staff cellar add was allowed';
end;
$$;
reset role;

-- One keyed add creates one inventory row and replays its exact original body.
select set_config('request.jwt.claim.sub', '70000000-0000-4000-8000-000000000001', false);
set role authenticated;
do $$
declare
  v_hash text := pg_temp.request_hash(
    '{"body":{"country":null,"name":"Reserve","producer":"Domaine Test","quantity":3,"region":null,"unit_cost":25,"varietal":null,"vintage":null}}'
  );
  v_first record;
  v_replay record;
begin
  select * into v_first from public.add_cellar_wine_idempotent(
    '70100000-0000-4000-8000-000000000001', 'Reserve', 'Domaine Test', null,
    null, null, null, 3, 25, 'add_replay_key_0070', v_hash
  );
  select * into v_replay from public.add_cellar_wine_idempotent(
    '70100000-0000-4000-8000-000000000001', 'Reserve', 'Domaine Test', null,
    null, null, null, 3, 25, 'add_replay_key_0070', v_hash
  );
  if v_first.outcome <> 'added' or v_first.response_status <> 200
     or v_first.replayed or v_replay.outcome <> 'replay'
     or not v_replay.replayed or v_replay.response_body <> v_first.response_body then
    raise exception 'add replay malformed: fresh=%, replay=%', row_to_json(v_first), row_to_json(v_replay);
  end if;
end;
$$;
reset role;

do $$
begin
  if (select count(*) from public.inventory_items where restaurant_id = '70100000-0000-4000-8000-000000000001') <> 1 then
    raise exception 'keyed add created duplicate inventory';
  end if;
end;
$$;

-- Completion failure rolls the inventory insert and its claim back together.
create or replace function public.reject_cellar_add_completion_0070()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.operation_id = 'api:POST:/api/cellar' and new.idempotency_key = 'add_rollback_key_0070' and new.state = 'completed' then
    raise exception using errcode = '40001', message = 'forced completion failure';
  end if;
  return new;
end;
$$;
create trigger reject_cellar_add_completion_0070 before update on public.api_idempotency
for each row execute function public.reject_cellar_add_completion_0070();

select set_config('request.jwt.claim.sub', '70000000-0000-4000-8000-000000000001', false);
set role authenticated;
do $$
begin
  begin
    perform * from public.add_cellar_wine_idempotent(
      '70100000-0000-4000-8000-000000000001', 'Rollback', 'Domaine Test', null,
      null, null, null, 1, 0, 'add_rollback_key_0070',
      pg_temp.request_hash('{"body":{"country":null,"name":"Rollback","producer":"Domaine Test","quantity":1,"region":null,"unit_cost":0,"varietal":null,"vintage":null}}')
    );
  exception when sqlstate '40001' then return;
  end;
  raise exception 'forced cellar add completion failure did not abort';
end;
$$;
reset role;

do $$
begin
  if exists (select 1 from public.wines where restaurant_id = '70100000-0000-4000-8000-000000000001' and name = 'Rollback')
     or exists (select 1 from public.api_idempotency where idempotency_key = 'add_rollback_key_0070') then
    raise exception 'add completion failure did not roll back atomically';
  end if;
end;
$$;

drop trigger reject_cellar_add_completion_0070 on public.api_idempotency;
drop function public.reject_cellar_add_completion_0070();

-- A keyed delete commits exactly once and replays after the wine is gone.
insert into public.wines (id, restaurant_id, name, producer, size_ml)
values ('70110000-0000-4000-8000-000000000001', '70100000-0000-4000-8000-000000000001', 'Delete Me', 'Domaine Test', 750);
select set_config('request.jwt.claim.sub', '70000000-0000-4000-8000-000000000001', false);
set role authenticated;
do $$
declare
  v_hash text := pg_temp.request_hash('{"id":"70110000-0000-4000-8000-000000000001"}');
  v_first record;
  v_replay record;
begin
  select * into v_first from public.delete_cellar_wine_idempotent(
    '70100000-0000-4000-8000-000000000001', '70110000-0000-4000-8000-000000000001',
    'delete_replay_key_0070', v_hash
  );
  select * into v_replay from public.delete_cellar_wine_idempotent(
    '70100000-0000-4000-8000-000000000001', '70110000-0000-4000-8000-000000000001',
    'delete_replay_key_0070', v_hash
  );
  if v_first.outcome <> 'deleted' or v_first.response_body <> '{"deleted":true}'::jsonb
     or v_replay.outcome <> 'replay' or not v_replay.replayed
     or v_replay.response_body <> v_first.response_body then
    raise exception 'delete replay malformed: fresh=%, replay=%', row_to_json(v_first), row_to_json(v_replay);
  end if;
end;
$$;
reset role;

delete from public.api_idempotency where user_id::text like '70000000-0000-4000-8000-00000000000%';
delete from public.restaurants where id::text like '70100000-0000-4000-8000-00000000000%';
delete from auth.users where id::text like '70000000-0000-4000-8000-00000000000%';
select set_config('request.jwt.claim.sub', '', false);
