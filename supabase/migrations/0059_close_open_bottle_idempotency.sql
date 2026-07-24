-- TER-020D08 — atomically close one exact open-bottle generation and store
-- or replay the command response.
--
-- The previous route read the bottle and then called record_pour in separate
-- statements. That could close a replacement bottle after a stale page action
-- and could commit the spill before an idempotency response was durable. This
-- dedicated boundary binds generation validation, spill, trigger-maintained
-- state, and response completion to one PostgreSQL transaction.

create or replace function public.close_open_bottle_idempotent(
  p_restaurant_id uuid,
  p_bottle_id uuid,
  p_expected_opened_at timestamptz,
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
  v_bottle public.open_bottles%rowtype;
  v_wine_id uuid;
  v_body jsonb;
  v_status integer;
  v_outcome text;
  v_now timestamptz;
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication required';
  end if;

  if p_restaurant_id is null
     or p_bottle_id is null
     or p_expected_opened_at is null then
    raise exception using
      errcode = '22023',
      message =
        'restaurant_id, bottle_id, and expected_opened_at are required';
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
           or v_claim.operation_id
                <> 'api:POST:/api/open-bottles/{param}/close'
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
        'api:POST:/api/open-bottles/{param}/close',
        p_idempotency_key,
        p_request_hash
      )
      on conflict (user_id, idempotency_key) do nothing;

      if found then
        exit;
      end if;
    end loop;
  end if;

  -- Discover the tenant-scoped parent, then take locks in the manual bottle
  -- lifecycle order: wine first, exact bottle second. The exact bottle is
  -- re-read under lock before any generation or closed-state decision.
  select open_bottles.wine_id
  into v_wine_id
  from public.open_bottles
  where open_bottles.id = p_bottle_id
    and open_bottles.restaurant_id = p_restaurant_id;

  if not found then
    v_outcome := 'not_found';
    v_status := 404;
    v_body := jsonb_build_object(
      'error',
      jsonb_build_object(
        'code', 'not_found',
        'message', 'Bottle not found.'
      )
    );
  else
    select wines.id
    into v_wine_id
    from public.wines
    where wines.id = v_wine_id
      and wines.restaurant_id = p_restaurant_id
    for update;

    if not found then
      v_outcome := 'not_found';
      v_status := 404;
      v_body := jsonb_build_object(
        'error',
        jsonb_build_object(
          'code', 'not_found',
          'message', 'Bottle not found.'
        )
      );
    else
      select *
      into v_bottle
      from public.open_bottles
      where open_bottles.id = p_bottle_id
        and open_bottles.wine_id = v_wine_id
        and open_bottles.restaurant_id = p_restaurant_id
      for update;

      if not found then
        v_outcome := 'not_found';
        v_status := 404;
        v_body := jsonb_build_object(
          'error',
          jsonb_build_object(
            'code', 'not_found',
            'message', 'Bottle not found.'
          )
        );
      elsif v_bottle.opened_at <> p_expected_opened_at then
        v_outcome := 'stale_open_bottle';
        v_status := 409;
        v_body := jsonb_build_object(
          'error',
          jsonb_build_object(
            'code', 'stale_open_bottle',
            'message',
            'This bottle was reopened after the page loaded. Refresh and try again.'
          )
        );
      elsif v_bottle.closed_at is not null then
        v_outcome := 'already_closed';
        v_status := 409;
        v_body := jsonb_build_object(
          'error',
          jsonb_build_object(
            'code', 'already_closed',
            'message', 'Bottle is already closed.'
          )
        );
      else
        insert into public.pour_events (
          wine_id,
          restaurant_id,
          ml_delta,
          kind,
          actor_user_id,
          note,
          open_bottle_id
        ) values (
          v_bottle.wine_id,
          p_restaurant_id,
          v_bottle.remaining_ml,
          'spill',
          v_user_id,
          'Bottle closed (discard remaining)',
          v_bottle.id
        );

        select *
        into v_bottle
        from public.open_bottles
        where open_bottles.id = p_bottle_id
          and open_bottles.wine_id = v_wine_id
          and open_bottles.restaurant_id = p_restaurant_id;

        if not found
           or v_bottle.remaining_ml <> 0
           or v_bottle.closed_at is null then
          raise exception using
            errcode = '40001',
            message = 'close bottle trigger returned an invalid state';
        end if;

        v_outcome := 'closed';
        v_status := 200;
        v_body := jsonb_build_object(
          'closed',
          jsonb_build_object(
            'id', v_bottle.id,
            'wine_id', v_bottle.wine_id,
            'closed_at', v_bottle.closed_at
          )
        );
      end if;
    end if;
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
      and api_idempotency.operation_id
            = 'api:POST:/api/open-bottles/{param}/close'
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
  select v_outcome, v_status, v_body, false;
end;
$$;

revoke all on function public.close_open_bottle_idempotent(
  uuid,
  uuid,
  timestamptz,
  text,
  text
) from public;
revoke all on function public.close_open_bottle_idempotent(
  uuid,
  uuid,
  timestamptz,
  text,
  text
) from anon;
grant execute on function public.close_open_bottle_idempotent(
  uuid,
  uuid,
  timestamptz,
  text,
  text
) to authenticated;

comment on function public.close_open_bottle_idempotent(
  uuid,
  uuid,
  timestamptz,
  text,
  text
) is
  'Atomically closes one exact open-bottle generation and stores or replays its response.';
