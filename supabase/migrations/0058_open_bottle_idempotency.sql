-- TER-020D03 follow-up — make the open-bottle mutation and its idempotency
-- response one transaction.
--
-- The generic API wrapper committed open_bottle_from_inventory before calling
-- complete_api_idempotency. A completion failure could therefore consume a
-- sealed bottle while leaving the key permanently in progress. This dedicated
-- boundary binds the claim, existing atomic mutation, and stored response to
-- the transaction of one PostgreSQL statement.

create or replace function public.open_bottle_from_inventory_idempotent(
  p_restaurant_id uuid,
  p_wine_id uuid,
  p_idempotency_key text default null,
  p_request_hash text default null
) returns table (
  outcome text,
  response_status integer,
  response_body jsonb,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_claim public.api_idempotency%rowtype;
  v_open record;
  v_body jsonb;
  v_status integer;
  v_now timestamptz;
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

    -- Serialize dedicated open calls for one user/key. A generic claim from an
    -- older application process can still race this function; the loop treats
    -- the unique key as authoritative after that transaction commits.
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
           or v_claim.operation_id <> 'api:POST:/api/open-bottles'
           or v_claim.request_hash <> p_request_hash then
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
            false;
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
            false;
          return;
        end if;

        if v_claim.state = 'completed' then
          return query
          select
            'replay'::text,
            v_claim.response_status,
            v_claim.response_body,
            true;
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
            false;
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
          false;
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
        'api:POST:/api/open-bottles',
        p_idempotency_key,
        p_request_hash
      )
      on conflict (user_id, idempotency_key) do nothing;

      if found then
        exit;
      end if;
    end loop;
  end if;

  select *
  into v_open
  from public.open_bottle_from_inventory(
    p_restaurant_id,
    p_wine_id
  );

  if not found then
    raise exception using
      errcode = '40001',
      message = 'open bottle command returned no result';
  end if;

  if v_open.outcome = 'not_found' then
    v_status := 404;
    v_body := jsonb_build_object(
      'error',
      jsonb_build_object(
        'code', 'not_found',
        'message', 'Wine not found.'
      )
    );
  elsif v_open.outcome = 'no_sealed_stock' then
    v_status := 409;
    v_body := jsonb_build_object(
      'error',
      jsonb_build_object(
        'code', 'no_sealed_stock',
        'message', 'No sealed bottles available to open.'
      )
    );
  elsif v_open.outcome = 'opened'
        and v_open.bottle_id is not null
        and v_open.wine_id is not null
        and v_open.remaining_ml is not null
        and v_open.opened_at is not null then
    v_status := 201;
    v_body := jsonb_build_object(
      'open_bottle',
      jsonb_build_object(
        'id', v_open.bottle_id,
        'wine_id', v_open.wine_id,
        'remaining_ml', v_open.remaining_ml,
        'opened_at', v_open.opened_at
      )
    );
  else
    raise exception using
      errcode = '40001',
      message = 'open bottle command returned an invalid result';
  end if;

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
      and api_idempotency.operation_id = 'api:POST:/api/open-bottles'
      and api_idempotency.idempotency_key = p_idempotency_key
      and api_idempotency.request_hash = p_request_hash
      and api_idempotency.state = 'in_progress';

    if not found then
      raise exception using
        errcode = '40001',
        message = 'idempotency completion changed concurrently';
    end if;
  end if;

  return query
  select v_open.outcome::text, v_status, v_body, false;
end;
$$;

revoke all on function public.open_bottle_from_inventory_idempotent(
  uuid,
  uuid,
  text,
  text
) from public;
revoke all on function public.open_bottle_from_inventory_idempotent(
  uuid,
  uuid,
  text,
  text
) from anon;
grant execute on function public.open_bottle_from_inventory_idempotent(
  uuid,
  uuid,
  text,
  text
) to authenticated;

comment on function public.open_bottle_from_inventory_idempotent(
  uuid,
  uuid,
  text,
  text
) is
  'Atomically opens sealed inventory and stores or replays its exact keyed response.';
