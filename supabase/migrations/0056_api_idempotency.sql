-- TER-020D02 — generalized authenticated request idempotency.
--
-- A key is globally bound per authenticated user. Tenant, operation, and
-- request hash are immutable attributes of that binding, so cross-endpoint or
-- cross-tenant reuse cannot silently create a second mutation. The table is
-- not a client API: authenticated callers can only use the SECURITY DEFINER
-- RPCs below.

create table public.api_idempotency (
  restaurant_id   uuid        not null references public.restaurants(id) on delete cascade,
  user_id         uuid        not null references auth.users(id) on delete cascade,
  operation_id    text        not null check (
    operation_id ~ '^[A-Za-z0-9][A-Za-z0-9:/_.{}-]{0,199}$'
  ),
  idempotency_key text        not null check (
    char_length(idempotency_key) between 8 and 128
    and idempotency_key ~ '^[A-Za-z0-9_-]+$'
  ),
  request_hash    text        not null check (
    request_hash ~ '^[0-9a-f]{64}$'
  ),
  state           text        not null default 'in_progress' check (
    state in ('in_progress', 'completed', 'failed_unknown')
  ),
  response_status integer,
  response_headers jsonb,
  response_body   jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  completed_at    timestamptz,
  primary key (user_id, idempotency_key),
  constraint api_idempotency_response_state check (
    (
      state = 'in_progress'
      and response_status is null
      and response_headers is null
      and response_body is null
      and completed_at is null
    )
    or (
      state = 'failed_unknown'
      and response_status is null
      and response_headers is null
      and response_body is null
      and completed_at is null
    )
    or (
      state = 'completed'
      and response_status between 100 and 599
      and jsonb_typeof(response_headers) = 'object'
      and response_body is not null
      and completed_at is not null
    )
  )
);

create index api_idempotency_updated_at_idx
  on public.api_idempotency (updated_at);

alter table public.api_idempotency enable row level security;

revoke all on table public.api_idempotency from public;
revoke all on table public.api_idempotency from anon;
revoke all on table public.api_idempotency from authenticated;

create or replace function public.claim_api_idempotency(
  p_restaurant_id uuid,
  p_operation_id text,
  p_idempotency_key text,
  p_request_hash text
) returns table (
  outcome text,
  response_status integer,
  response_headers jsonb,
  response_body jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_claim public.api_idempotency%rowtype;
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication required';
  end if;

  if p_restaurant_id is null then
    raise exception using
      errcode = '22023',
      message = 'restaurant_id is required';
  end if;

  if p_operation_id is null
     or p_operation_id !~ '^[A-Za-z0-9][A-Za-z0-9:/_.{}-]{0,199}$' then
    raise exception using
      errcode = '22023',
      message = 'invalid operation_id';
  end if;

  if p_idempotency_key is null
     or char_length(p_idempotency_key) not between 8 and 128
     or p_idempotency_key !~ '^[A-Za-z0-9_-]+$' then
    raise exception using
      errcode = '22023',
      message = 'invalid idempotency key';
  end if;

  if p_request_hash is null
     or p_request_hash !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = '22023',
      message = 'invalid request hash';
  end if;

  if not exists (
    select 1
    from public.memberships
    where memberships.restaurant_id = p_restaurant_id
      and memberships.user_id = v_user_id
  ) then
    raise exception using
      errcode = '42501',
      message = 'forbidden';
  end if;

  loop
    insert into public.api_idempotency (
      restaurant_id,
      user_id,
      operation_id,
      idempotency_key,
      request_hash
    ) values (
      p_restaurant_id,
      v_user_id,
      p_operation_id,
      p_idempotency_key,
      p_request_hash
    )
    on conflict (user_id, idempotency_key) do nothing
    returning * into v_claim;

    if found then
      return query
      select
        'claimed'::text,
        null::integer,
        null::jsonb,
        null::jsonb;
      return;
    end if;

    -- ON CONFLICT waits for a concurrent winner to commit or roll back. Each
    -- PL/pgSQL statement receives a fresh READ COMMITTED snapshot, so this
    -- lookup observes the committed winner. A concurrent release/cleanup can
    -- still remove it before the SELECT; in that case, loop and claim again.
    select *
    into v_claim
    from public.api_idempotency
    where api_idempotency.user_id = v_user_id
      and api_idempotency.idempotency_key = p_idempotency_key;

    if not found then
      continue;
    end if;

    if v_claim.restaurant_id <> p_restaurant_id
       or v_claim.operation_id <> p_operation_id
       or v_claim.request_hash <> p_request_hash then
      return query
      select
        'mismatch'::text,
        null::integer,
        null::jsonb,
        null::jsonb;
      return;
    end if;

    if v_claim.updated_at < clock_timestamp() - interval '24 hours' then
      return query
      select
        'expired'::text,
        null::integer,
        null::jsonb,
        null::jsonb;
      return;
    end if;

    if v_claim.state = 'completed' then
      return query
      select
        'replay'::text,
        v_claim.response_status,
        v_claim.response_headers,
        v_claim.response_body;
      return;
    end if;

    if v_claim.state = 'failed_unknown' then
      return query
      select
        'outcome_unknown'::text,
        null::integer,
        null::jsonb,
        null::jsonb;
      return;
    end if;

    return query
    select
      'in_progress'::text,
      null::integer,
      null::jsonb,
      null::jsonb;
    return;
  end loop;
end;
$$;

revoke all on function public.claim_api_idempotency(
  uuid,
  text,
  text,
  text
) from public;
revoke all on function public.claim_api_idempotency(
  uuid,
  text,
  text,
  text
) from anon;
grant execute on function public.claim_api_idempotency(
  uuid,
  text,
  text,
  text
) to authenticated;

create or replace function public.complete_api_idempotency(
  p_restaurant_id uuid,
  p_operation_id text,
  p_idempotency_key text,
  p_request_hash text,
  p_response_status integer,
  p_response_headers jsonb,
  p_response_body jsonb
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_now timestamptz;
  v_updated boolean;
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication required';
  end if;

  if p_restaurant_id is null then
    raise exception using
      errcode = '22023',
      message = 'restaurant_id is required';
  end if;

  if p_operation_id is null
     or p_operation_id !~ '^[A-Za-z0-9][A-Za-z0-9:/_.{}-]{0,199}$' then
    raise exception using
      errcode = '22023',
      message = 'invalid operation_id';
  end if;

  if p_idempotency_key is null
     or char_length(p_idempotency_key) not between 8 and 128
     or p_idempotency_key !~ '^[A-Za-z0-9_-]+$' then
    raise exception using
      errcode = '22023',
      message = 'invalid idempotency key';
  end if;

  if p_request_hash is null
     or p_request_hash !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = '22023',
      message = 'invalid request hash';
  end if;

  if p_response_status is null
     or p_response_status not between 100 and 599 then
    raise exception using
      errcode = '22023',
      message = 'invalid response status';
  end if;

  if p_response_body is null then
    raise exception using
      errcode = '22023',
      message = 'response body is required';
  end if;

  if p_response_headers is null
     or jsonb_typeof(p_response_headers) <> 'object' then
    raise exception using
      errcode = '22023',
      message = 'response headers must be a JSON object';
  end if;

  if octet_length(p_response_headers::text) > 65536 then
    raise exception using
      errcode = '22023',
      message = 'response headers exceed 64 KiB';
  end if;

  if octet_length(p_response_body::text) > 1048576 then
    raise exception using
      errcode = '22023',
      message = 'response body exceeds 1 MiB';
  end if;

  v_now := clock_timestamp();

  update public.api_idempotency
  set state = 'completed',
      response_status = p_response_status,
      response_headers = p_response_headers,
      response_body = p_response_body,
      updated_at = v_now,
      completed_at = v_now
  where api_idempotency.restaurant_id = p_restaurant_id
    and api_idempotency.user_id = v_user_id
    and api_idempotency.operation_id = p_operation_id
    and api_idempotency.idempotency_key = p_idempotency_key
    and api_idempotency.request_hash = p_request_hash
    and api_idempotency.state = 'in_progress'
  returning true into v_updated;

  return coalesce(v_updated, false);
end;
$$;

revoke all on function public.complete_api_idempotency(
  uuid,
  text,
  text,
  text,
  integer,
  jsonb,
  jsonb
) from public;
revoke all on function public.complete_api_idempotency(
  uuid,
  text,
  text,
  text,
  integer,
  jsonb,
  jsonb
) from anon;
grant execute on function public.complete_api_idempotency(
  uuid,
  text,
  text,
  text,
  integer,
  jsonb,
  jsonb
) to authenticated;

create or replace function public.fail_api_idempotency(
  p_restaurant_id uuid,
  p_operation_id text,
  p_idempotency_key text,
  p_request_hash text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_updated boolean;
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication required';
  end if;

  if p_restaurant_id is null then
    raise exception using
      errcode = '22023',
      message = 'restaurant_id is required';
  end if;

  if p_operation_id is null
     or p_operation_id !~ '^[A-Za-z0-9][A-Za-z0-9:/_.{}-]{0,199}$' then
    raise exception using
      errcode = '22023',
      message = 'invalid operation_id';
  end if;

  if p_idempotency_key is null
     or char_length(p_idempotency_key) not between 8 and 128
     or p_idempotency_key !~ '^[A-Za-z0-9_-]+$' then
    raise exception using
      errcode = '22023',
      message = 'invalid idempotency key';
  end if;

  if p_request_hash is null
     or p_request_hash !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = '22023',
      message = 'invalid request hash';
  end if;

  update public.api_idempotency
  set state = 'failed_unknown',
      updated_at = clock_timestamp()
  where api_idempotency.user_id = v_user_id
    and api_idempotency.idempotency_key = p_idempotency_key
    and api_idempotency.restaurant_id = p_restaurant_id
    and api_idempotency.operation_id = p_operation_id
    and api_idempotency.request_hash = p_request_hash
    and api_idempotency.state = 'in_progress'
  returning true into v_updated;

  return coalesce(v_updated, false);
end;
$$;

revoke all on function public.fail_api_idempotency(
  uuid,
  text,
  text,
  text
) from public;
revoke all on function public.fail_api_idempotency(
  uuid,
  text,
  text,
  text
) from anon;
grant execute on function public.fail_api_idempotency(
  uuid,
  text,
  text,
  text
) to authenticated;

create or replace function public.release_api_idempotency(
  p_restaurant_id uuid,
  p_operation_id text,
  p_idempotency_key text,
  p_request_hash text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_deleted boolean;
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication required';
  end if;

  if p_restaurant_id is null then
    raise exception using
      errcode = '22023',
      message = 'restaurant_id is required';
  end if;

  if p_operation_id is null
     or p_operation_id !~ '^[A-Za-z0-9][A-Za-z0-9:/_.{}-]{0,199}$' then
    raise exception using
      errcode = '22023',
      message = 'invalid operation_id';
  end if;

  if p_idempotency_key is null
     or char_length(p_idempotency_key) not between 8 and 128
     or p_idempotency_key !~ '^[A-Za-z0-9_-]+$' then
    raise exception using
      errcode = '22023',
      message = 'invalid idempotency key';
  end if;

  if p_request_hash is null
     or p_request_hash !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = '22023',
      message = 'invalid request hash';
  end if;

  delete from public.api_idempotency
  where api_idempotency.restaurant_id = p_restaurant_id
    and api_idempotency.user_id = v_user_id
    and api_idempotency.operation_id = p_operation_id
    and api_idempotency.idempotency_key = p_idempotency_key
    and api_idempotency.request_hash = p_request_hash
    and api_idempotency.state = 'in_progress'
  returning true into v_deleted;

  return coalesce(v_deleted, false);
end;
$$;

revoke all on function public.release_api_idempotency(
  uuid,
  text,
  text,
  text
) from public;
revoke all on function public.release_api_idempotency(
  uuid,
  text,
  text,
  text
) from anon;
grant execute on function public.release_api_idempotency(
  uuid,
  text,
  text,
  text
) to authenticated;

create or replace function public.cleanup_api_idempotency()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted bigint;
begin
  delete from public.api_idempotency
  where updated_at < clock_timestamp() - interval '25 hours';

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.cleanup_api_idempotency() from public;
revoke all on function public.cleanup_api_idempotency() from anon;
revoke all on function public.cleanup_api_idempotency()
  from authenticated;
grant execute on function public.cleanup_api_idempotency()
  to service_role;

select cron.schedule(
  'cleanup_api_idempotency_hourly',
  '25 * * * *',
  $$select public.cleanup_api_idempotency();$$
);

comment on table public.api_idempotency is
  'Per-user request-key bindings with a 24-hour observable TTL and 25-hour cleanup window.';

comment on function public.claim_api_idempotency(uuid, text, text, text) is
  'Atomically binds a user key or returns replay, in-progress, mismatch, expired, or outcome-unknown.';

comment on function public.complete_api_idempotency(
  uuid,
  text,
  text,
  text,
  integer,
  jsonb,
  jsonb
) is
  'Completes a matching caller-owned claim with a cached HTTP status, headers, and JSON body.';

comment on function public.fail_api_idempotency(uuid, text, text, text) is
  'Marks a matching caller-owned in-progress claim as having an ambiguous mutation outcome.';

comment on function public.release_api_idempotency(uuid, text, text, text) is
  'Releases only a matching caller-owned in-progress claim.';

comment on function public.cleanup_api_idempotency() is
  'Deletes request-idempotency rows whose last update is older than 25 hours.';
