-- TER-020D20 — preserve exact retry semantics for restaurant deletion.
--
-- A restaurant is the root of the tenant graph. Deleting it cascades the
-- caller's membership and, before this migration, the generic idempotency
-- record itself. Keep those private records for their existing 24-hour
-- observable TTL and execute the delete plus response completion in one
-- transaction. The existing cleanup job still removes expired records.

create extension if not exists pgcrypto with schema extensions;

alter table public.api_idempotency
  drop constraint if exists api_idempotency_restaurant_id_fkey;

create or replace function public.delete_restaurant_idempotent(
  p_restaurant_id uuid,
  p_active_restaurant_id uuid default null,
  p_idempotency_key text default null,
  p_request_hash text default null
) returns table (
  outcome text,
  response_status integer,
  response_body jsonb,
  replayed boolean,
  execution_started_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_claim public.api_idempotency%rowtype;
  v_role public.membership_role;
  v_identity text;
  v_request_hash text;
  v_now timestamptz;
  v_started_at timestamptz := now();
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

  -- createIdempotencyRequestHash({ id }) sorts this single key and frames the
  -- UTF-8 canonical JSON with an eight-byte big-endian length.
  v_identity :=
    '{"id":' || pg_catalog.to_json(p_restaurant_id::text)::text || '}';
  v_request_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.int8send(
        pg_catalog.octet_length(
          pg_catalog.convert_to(v_identity, 'UTF8')
        )::bigint
      ) || pg_catalog.convert_to(v_identity, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  if p_idempotency_key is null and p_request_hash is not null then
    raise exception using
      errcode = '22023',
      message = 'request hash requires an idempotency key';
  end if;

  if p_idempotency_key is not null then
    if char_length(p_idempotency_key) not between 8 and 128
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

    if p_request_hash <> v_request_hash then
      raise exception using
        errcode = '22023',
        message = 'request hash does not match the canonical deletion identity';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        v_user_id::text || ':' || p_idempotency_key,
        0
      )
    );

    select *
    into v_claim
    from public.api_idempotency
    where api_idempotency.user_id = v_user_id
      and api_idempotency.idempotency_key = p_idempotency_key
    for update;

    if found then
      if v_claim.restaurant_id <> p_restaurant_id
         or v_claim.operation_id
              <> 'api:DELETE:/api/restaurant/{param}'
         or v_claim.request_hash <> v_request_hash then
        return query
        select
          'idempotency_key_reused'::text,
          409,
          jsonb_build_object(
            'error',
            jsonb_build_object(
              'code', 'idempotency_key_reused',
              'message',
              'This Idempotency-Key was already used for a different request.'
            )
          ),
          false,
          v_claim.created_at;
        return;
      end if;

      if v_claim.updated_at
           < clock_timestamp() - interval '24 hours' then
        return query
        select
          'idempotency_key_expired'::text,
          409,
          jsonb_build_object(
            'error',
            jsonb_build_object(
              'code', 'idempotency_key_expired',
              'message', 'This Idempotency-Key has expired.'
            )
          ),
          false,
          v_claim.created_at;
        return;
      end if;

      if v_claim.state = 'completed' then
        return query
        select
          'replay'::text,
          v_claim.response_status,
          v_claim.response_body,
          true,
          v_claim.created_at;
        return;
      end if;

      if v_claim.state = 'failed_unknown' then
        return query
        select
          'idempotency_outcome_unknown'::text,
          409,
          jsonb_build_object(
            'error',
            jsonb_build_object(
              'code', 'idempotency_outcome_unknown',
              'message',
              'The original request outcome is unknown and will not be retried.'
            )
          ),
          false,
          v_claim.created_at;
        return;
      end if;

      return query
      select
        'idempotency_in_progress'::text,
        409,
        jsonb_build_object(
          'error',
          jsonb_build_object(
            'code', 'idempotency_in_progress',
            'message',
            'A request with this Idempotency-Key is still in progress.'
          )
        ),
        false,
        v_claim.created_at;
      return;
    end if;
  end if;

  -- Preserve the prior route's active-tenant and owner semantics for every
  -- new command. Replays above are intentionally resolved first because the
  -- successful delete has already cascaded this membership.
  if p_active_restaurant_id is null then
    return query
    select
      'no_membership'::text,
      403,
      jsonb_build_object(
        'error',
        jsonb_build_object(
          'code', 'forbidden',
          'message', 'No restaurant membership found.'
        )
      ),
      false,
      v_started_at;
    return;
  end if;

  if p_active_restaurant_id <> p_restaurant_id then
    return query
    select
      'forbidden'::text,
      403,
      jsonb_build_object(
        'error',
        jsonb_build_object(
          'code', 'forbidden',
          'message', 'Forbidden.'
        )
      ),
      false,
      v_started_at;
    return;
  end if;

  select role
  into v_role
  from public.memberships
  where restaurant_id = p_restaurant_id
    and user_id = v_user_id
  for update;

  if not found then
    return query
    select
      'no_membership'::text,
      403,
      jsonb_build_object(
        'error',
        jsonb_build_object(
          'code', 'forbidden',
          'message', 'No restaurant membership found.'
        )
      ),
      false,
      v_started_at;
    return;
  end if;

  if v_role <> 'owner' then
    return query
    select
      'owner_required'::text,
      403,
      jsonb_build_object(
        'error',
        jsonb_build_object(
          'code', 'forbidden',
          'message', 'Owner access required.'
        )
      ),
      false,
      v_started_at;
    return;
  end if;

  if p_idempotency_key is not null then
    insert into public.api_idempotency (
      restaurant_id,
      user_id,
      operation_id,
      idempotency_key,
      request_hash
    ) values (
      p_restaurant_id,
      v_user_id,
      'api:DELETE:/api/restaurant/{param}',
      p_idempotency_key,
      v_request_hash
    )
    returning * into v_claim;

    v_started_at := v_claim.created_at;
  end if;

  delete from public.restaurants
  where id = p_restaurant_id;

  if not found then
    raise exception using
      errcode = '40001',
      message = 'restaurant deletion target changed concurrently';
  end if;

  if p_idempotency_key is not null then
    v_now := clock_timestamp();
    update public.api_idempotency
    set state = 'completed',
        response_status = 200,
        response_headers = '{}'::jsonb,
        response_body = jsonb_build_object('ok', true),
        updated_at = v_now,
        completed_at = v_now
    where api_idempotency.restaurant_id = p_restaurant_id
      and api_idempotency.user_id = v_user_id
      and api_idempotency.operation_id
            = 'api:DELETE:/api/restaurant/{param}'
      and api_idempotency.idempotency_key = p_idempotency_key
      and api_idempotency.request_hash = v_request_hash
      and api_idempotency.state = 'in_progress';

    if not found then
      raise exception using
        errcode = '40001',
        message = 'idempotency completion changed concurrently';
    end if;
  end if;

  return query
  select
    'deleted'::text,
    200,
    jsonb_build_object('ok', true),
    false,
    v_started_at;
end;
$$;

revoke all on function public.delete_restaurant_idempotent(
  uuid,
  uuid,
  text,
  text
) from public;
revoke all on function public.delete_restaurant_idempotent(
  uuid,
  uuid,
  text,
  text
) from anon;
grant execute on function public.delete_restaurant_idempotent(
  uuid,
  uuid,
  text,
  text
) to authenticated;

comment on function public.delete_restaurant_idempotent(
  uuid,
  uuid,
  text,
  text
) is
  'Atomically deletes the active owner restaurant and stores or replays the exact keyed API response.';

comment on column public.api_idempotency.restaurant_id is
  'Immutable tenant identity. Intentionally retained after tenant deletion until the private idempotency record expires.';
