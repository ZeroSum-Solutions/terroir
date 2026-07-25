-- TER-020D09 — bind pour idempotency and the canonical record_pour mutation
-- to one PostgreSQL transaction.
--
-- record_pour already owns the complete pour/open/overage business
-- transaction. This boundary adds a caller-scoped idempotency claim, stores
-- the exact API response, and invokes record_pour directly. Both functions are
-- SECURITY DEFINER and continue to derive the actor from auth.uid(); no dynamic
-- SQL or role switching changes the authenticated execution context.

create extension if not exists pgcrypto with schema extensions;

create or replace function public.record_pour_idempotent(
  p_restaurant_id uuid,
  p_wine_id uuid,
  p_ml int,
  p_kind text default 'pour',
  p_note text default null,
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
  v_open public.open_bottles%rowtype;
  v_note text := nullif(btrim(p_note), '');
  v_identity text;
  v_request_hash text;
  v_message text;
  v_outcome text;
  v_body jsonb;
  v_status integer;
  v_now timestamptz;
  v_started_at timestamptz := now();
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication required';
  end if;

  if p_restaurant_id is null or p_wine_id is null then
    raise exception using
      errcode = '22023',
      message = 'restaurant_id and wine_id are required';
  end if;

  if not public.is_member_with_role(p_restaurant_id, 'staff') then
    raise exception using
      errcode = '42501',
      message = 'forbidden';
  end if;

  if p_ml is null or p_ml <= 0 or p_ml > 2000 then
    raise exception using
      errcode = '22023',
      message = 'ml must be between 1 and 2000';
  end if;

  if p_kind is null or p_kind not in ('pour', 'spill') then
    raise exception using
      errcode = '22023',
      message = 'kind must be pour or spill';
  end if;

  if v_note is not null and char_length(v_note) > 500 then
    raise exception using
      errcode = '22023',
      message = 'note must not exceed 500 characters';
  end if;

  -- Match createIdempotencyRequestHash's sorted canonical JSON and
  -- length-prefixed SHA-256 framing. The database recomputes this value so a
  -- direct authenticated RPC caller cannot bind one key to a dishonest hash.
  v_identity :=
    '{"kind":' || pg_catalog.to_json(p_kind)::text ||
    ',"ml":' || p_ml::text ||
    ',"note":' || coalesce(pg_catalog.to_json(v_note)::text, 'null') ||
    ',"wine_id":' || pg_catalog.to_json(p_wine_id::text)::text || '}';
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
        message = 'request hash does not match the canonical pour identity';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        v_user_id::text || ':' || p_idempotency_key,
        0
      )
    );

    loop
      select *
      into v_claim
      from public.api_idempotency
      where api_idempotency.user_id = v_user_id
        and api_idempotency.idempotency_key = p_idempotency_key
      for update;

      if found then
        if v_claim.restaurant_id <> p_restaurant_id
           or v_claim.operation_id <> 'api:POST:/api/pour'
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

      insert into public.api_idempotency (
        restaurant_id,
        user_id,
        operation_id,
        idempotency_key,
        request_hash
      ) values (
        p_restaurant_id,
        v_user_id,
        'api:POST:/api/pour',
        p_idempotency_key,
        v_request_hash
      )
      on conflict (user_id, idempotency_key) do nothing
      returning * into v_claim;

      if found then
        v_started_at := v_claim.created_at;
        exit;
      end if;
    end loop;
  end if;

  begin
    select *
    into v_open
    from public.record_pour(
      p_restaurant_id,
      p_wine_id,
      p_ml,
      p_kind,
      v_note
    );

    if not found or v_open.id is null or v_open.wine_id is null then
      raise exception using
        errcode = '40001',
        message = 'record pour command returned an invalid result';
    end if;

    v_outcome := 'poured';
    v_status := 200;
    v_body := jsonb_build_object('open_bottle', to_jsonb(v_open));
  exception
    when sqlstate 'P0001' then
      get stacked diagnostics v_message = message_text;

      if v_message = 'TERROIR_OUT_OF_STOCK' then
        v_outcome := 'no_inventory';
        v_status := 409;
        v_body := jsonb_build_object(
          'error',
          jsonb_build_object(
            'code', 'no_inventory',
            'message', 'No inventory available.'
          )
        );
      elsif btrim(lower(v_message)) = 'wine not found' then
        v_outcome := 'not_found';
        v_status := 404;
        v_body := jsonb_build_object(
          'error',
          jsonb_build_object(
            'code', 'not_found',
            'message', 'Wine not found.'
          )
        );
      else
        raise;
      end if;
  end;

  if p_idempotency_key is not null then
    v_now := clock_timestamp();
    update public.api_idempotency
    set state = 'completed',
        response_status = v_status,
        response_headers = '{}'::jsonb,
        response_body = v_body,
        updated_at = v_now,
        completed_at = v_now
    where api_idempotency.restaurant_id = p_restaurant_id
      and api_idempotency.user_id = v_user_id
      and api_idempotency.operation_id = 'api:POST:/api/pour'
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
  select v_outcome, v_status, v_body, false, v_started_at;
end;
$$;

revoke all on function public.record_pour_idempotent(
  uuid,
  uuid,
  int,
  text,
  text,
  text,
  text
) from public;
revoke all on function public.record_pour_idempotent(
  uuid,
  uuid,
  int,
  text,
  text,
  text,
  text
) from anon;
grant execute on function public.record_pour_idempotent(
  uuid,
  uuid,
  int,
  text,
  text,
  text,
  text
) to authenticated;

comment on function public.record_pour_idempotent(
  uuid,
  uuid,
  int,
  text,
  text,
  text,
  text
) is
  'Atomically records a pour and stores or replays its exact keyed API response.';
