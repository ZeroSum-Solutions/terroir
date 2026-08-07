-- Concurrency acceptance for 0074_background_job_lifecycle.sql.
-- Run only against an isolated database migrated through 0074:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -v dblink_conn="$DATABASE_URL" \
--     -f supabase/tests/0074_background_job_concurrency.sql

\if :{?dblink_conn}
\else
\echo '0074 concurrency acceptance requires -v dblink_conn=<database URL>'
\quit 2
\endif

create extension if not exists dblink with schema extensions;

drop trigger if exists delay_background_enqueue_0074
  on public.background_jobs;
drop trigger if exists delay_background_claim_0074
  on public.background_jobs;
drop function if exists public.delay_background_enqueue_0074();
drop function if exists public.delay_background_claim_0074();

delete from public.restaurants
where id = '74400000-0000-4000-8000-000000000001';
delete from auth.users
where id = '74300000-0000-4000-8000-000000000001';

insert into auth.users (
  id,
  email,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
) values (
  '74300000-0000-4000-8000-000000000001',
  'jobs-concurrency@example.test',
  '{}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
);

insert into public.restaurants (id, name) values (
  '74400000-0000-4000-8000-000000000001',
  'Jobs Concurrency Restaurant'
);

insert into public.memberships (user_id, restaurant_id, role) values (
  '74300000-0000-4000-8000-000000000001',
  '74400000-0000-4000-8000-000000000001',
  'owner'
);

create or replace function public.delay_background_enqueue_0074()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.idempotency_key = 'concurrent-enqueue' then
    perform pg_catalog.pg_sleep(0.75);
  end if;
  return new;
end;
$$;

create trigger delay_background_enqueue_0074
before insert on public.background_jobs
for each row execute function public.delay_background_enqueue_0074();

select extensions.dblink_connect('jobs_0074_a', :'dblink_conn');
select extensions.dblink_connect('jobs_0074_b', :'dblink_conn');
select extensions.dblink_exec(
  'jobs_0074_a',
  'set request.jwt.claim.sub = ''74300000-0000-4000-8000-000000000001'''
);
select extensions.dblink_exec(
  'jobs_0074_b',
  'set request.jwt.claim.sub = ''74300000-0000-4000-8000-000000000001'''
);
select extensions.dblink_exec('jobs_0074_a', 'set role authenticated');
select extensions.dblink_exec('jobs_0074_b', 'set role authenticated');

select extensions.dblink_send_query(
  'jobs_0074_a',
  $sql$
    select (public.enqueue_background_job(
      '74400000-0000-4000-8000-000000000001',
      'invoice_ocr',
      'concurrent-enqueue',
      'invoice_scans',
      '74500000-0000-4000-8000-000000000001',
      '{"fixture":"same"}'::jsonb,
      3
    )).id
  $sql$
);
select pg_catalog.pg_sleep(0.10);
select extensions.dblink_send_query(
  'jobs_0074_b',
  $sql$
    select (public.enqueue_background_job(
      '74400000-0000-4000-8000-000000000001',
      'invoice_ocr',
      'concurrent-enqueue',
      'invoice_scans',
      '74500000-0000-4000-8000-000000000001',
      '{"fixture":"same"}'::jsonb,
      3
    )).id
  $sql$
);

create temporary table enqueue_concurrency_0074 (
  id uuid not null
);
insert into enqueue_concurrency_0074
select id
from extensions.dblink_get_result('jobs_0074_a') as result(id uuid);
insert into enqueue_concurrency_0074
select id
from extensions.dblink_get_result('jobs_0074_b') as result(id uuid);

do $$
begin
  if (select count(*) from enqueue_concurrency_0074) <> 2
     or (select count(distinct id) from enqueue_concurrency_0074) <> 1
     or (
       select count(*)
       from public.background_jobs
       where restaurant_id = '74400000-0000-4000-8000-000000000001'
         and job_type = 'invoice_ocr'
         and idempotency_key = 'concurrent-enqueue'
     ) <> 1 then
    raise exception 'concurrent idempotent enqueue created divergent jobs';
  end if;
end;
$$;

select extensions.dblink_disconnect('jobs_0074_a');
select extensions.dblink_disconnect('jobs_0074_b');
drop trigger delay_background_enqueue_0074 on public.background_jobs;
drop function public.delay_background_enqueue_0074();
delete from public.background_jobs
where restaurant_id = '74400000-0000-4000-8000-000000000001';

set request.jwt.claim.sub = '74300000-0000-4000-8000-000000000001';
set role authenticated;
select public.enqueue_background_job(
  '74400000-0000-4000-8000-000000000001',
  'wine_enrichment',
  'concurrent-claim-a'
);
select public.enqueue_background_job(
  '74400000-0000-4000-8000-000000000001',
  'wine_enrichment',
  'concurrent-claim-b'
);
reset role;

create or replace function public.delay_background_claim_0074()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status in ('queued', 'retrying') and new.status = 'running' then
    perform pg_catalog.pg_sleep(0.75);
  end if;
  return new;
end;
$$;

create trigger delay_background_claim_0074
before update on public.background_jobs
for each row execute function public.delay_background_claim_0074();

select extensions.dblink_connect('jobs_0074_a', :'dblink_conn');
select extensions.dblink_connect('jobs_0074_b', :'dblink_conn');
select extensions.dblink_exec('jobs_0074_a', 'set role service_role');
select extensions.dblink_exec('jobs_0074_b', 'set role service_role');

select extensions.dblink_send_query(
  'jobs_0074_a',
  $sql$
    select id
    from public.claim_background_jobs('concurrent-worker-a', 1, 120, 30)
  $sql$
);
select pg_catalog.pg_sleep(0.10);
select extensions.dblink_send_query(
  'jobs_0074_b',
  $sql$
    select id
    from public.claim_background_jobs('concurrent-worker-b', 1, 120, 30)
  $sql$
);

create temporary table claim_concurrency_0074 (
  id uuid not null
);
insert into claim_concurrency_0074
select id
from extensions.dblink_get_result('jobs_0074_a') as result(id uuid);
insert into claim_concurrency_0074
select id
from extensions.dblink_get_result('jobs_0074_b') as result(id uuid);

do $$
begin
  if (select count(*) from claim_concurrency_0074) <> 2
     or (select count(distinct id) from claim_concurrency_0074) <> 2
     or (
       select count(*)
       from public.background_jobs
       where restaurant_id = '74400000-0000-4000-8000-000000000001'
         and status = 'running'
         and attempt_count = 1
         and lease_token is not null
     ) <> 2 then
    raise exception 'concurrent workers did not claim distinct leased jobs';
  end if;
end;
$$;

select extensions.dblink_disconnect('jobs_0074_a');
select extensions.dblink_disconnect('jobs_0074_b');
drop trigger delay_background_claim_0074 on public.background_jobs;
drop function public.delay_background_claim_0074();

delete from public.restaurants
where id = '74400000-0000-4000-8000-000000000001';
delete from auth.users
where id = '74300000-0000-4000-8000-000000000001';

reset request.jwt.claim.sub;
