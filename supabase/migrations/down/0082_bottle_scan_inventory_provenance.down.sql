-- Reverse 0082 by restoring the 0066 confirmation function definition.

create or replace function public.confirm_bottle_scan_idempotent(
  p_restaurant_id uuid,
  p_wine_id uuid,
  p_section text,
  p_bin_location text,
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
  v_item public.inventory_items%rowtype;
  v_identity text;
  v_computed_hash text;
  v_outcome text;
  v_status integer;
  v_body jsonb;
  v_now timestamptz;
  v_started_at timestamptz := now();
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication required';
  end if;

  if p_restaurant_id is null
     or p_wine_id is null
     or p_section is null
     or p_bin_location is null then
    raise exception using
      errcode = '22023',
      message =
        'restaurant_id, wine_id, section, and bin_location are required';
  end if;

  if p_section <> pg_catalog.btrim(p_section)
     or char_length(p_section) not between 1 and 200
     or p_bin_location <> pg_catalog.btrim(p_bin_location)
     or char_length(p_bin_location) not between 1 and 200 then
    raise exception using
      errcode = '22023',
      message = 'section and bin_location must be normalized';
  end if;

  if not public.is_member_with_role(p_restaurant_id, 'staff') then
    raise exception using
      errcode = '42501',
      message = 'forbidden';
  end if;

  -- createIdempotencyRequestHash sorts keys before framing canonical JSON.
  -- Keep this reconstruction explicit so the database verifies the caller's
  -- exact normalized identity instead of trusting a supplied digest.
  v_identity :=
    '{"bin_location":'
      || pg_catalog.to_json(p_bin_location)::text
      || ',"section":'
      || pg_catalog.to_json(p_section)::text
      || ',"wine_id":'
      || pg_catalog.to_json(p_wine_id::text)::text
      || '}';
  v_computed_hash := pg_catalog.encode(
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
       or p_request_hash !~ '^[0-9a-f]{64}$'
       or p_request_hash <> v_computed_hash then
      raise exception using
        errcode = '22023',
        message =
          'request hash does not match the canonical confirmation identity';
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
                <> 'api:POST:/api/scan-bottle/confirm'
           or v_claim.request_hash <> v_computed_hash then
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
        'api:POST:/api/scan-bottle/confirm',
        p_idempotency_key,
        v_computed_hash
      )
      on conflict (user_id, idempotency_key) do nothing
      returning * into v_claim;

      if found then
        v_started_at := v_claim.created_at;
        exit;
      end if;
    end loop;
  end if;

  if not exists (
    select 1
    from public.wines
    where wines.id = p_wine_id
      and wines.restaurant_id = p_restaurant_id
  ) then
    v_outcome := 'wine_not_found';
    v_status := 404;
    v_body := jsonb_build_object(
      'error',
      jsonb_build_object(
        'code', 'wine_not_found',
        'message', 'Wine not found or not in your restaurant.'
      )
    );
  else
    insert into public.inventory_items (
      wine_id,
      restaurant_id,
      section,
      bin_location,
      quantity,
      unit_cost,
      added_via
    ) values (
      p_wine_id,
      p_restaurant_id,
      p_section,
      p_bin_location,
      1,
      0,
      'manual'
    )
    returning * into v_item;

    v_outcome := 'confirmed';
    v_status := 201;
    v_body := jsonb_build_object(
      'id', v_item.id,
      'section', v_item.section,
      'bin_location', v_item.bin_location,
      'added_at', v_item.added_at,
      'wine_id', v_item.wine_id
    );
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
            = 'api:POST:/api/scan-bottle/confirm'
      and api_idempotency.idempotency_key = p_idempotency_key
      and api_idempotency.request_hash = v_computed_hash
      and api_idempotency.state = 'in_progress';

    if not found then
      raise exception using
        errcode = '40001',
        message = 'idempotency completion changed concurrently';
    end if;
  end if;

  return query
  select
    v_outcome,
    v_status,
    v_body,
    false,
    v_started_at;
end;
$$;

revoke all on function public.confirm_bottle_scan_idempotent(
  uuid,
  uuid,
  text,
  text,
  text,
  text
) from public;
revoke all on function public.confirm_bottle_scan_idempotent(
  uuid,
  uuid,
  text,
  text,
  text,
  text
) from anon;
grant execute on function public.confirm_bottle_scan_idempotent(
  uuid,
  uuid,
  text,
  text,
  text,
  text
) to authenticated;

comment on function public.confirm_bottle_scan_idempotent(
  uuid,
  uuid,
  text,
  text,
  text,
  text
) is
  'Atomically inserts confirmed bottle inventory and stores or replays its exact keyed response.';
