-- TER-020D11 — atomically reconcile an ordered batch and store or replay the
-- exact route response.
--
-- The API validates and normalizes every entry before this boundary. The
-- database independently reconstructs the route's canonical, length-framed
-- SHA-256 identity so a caller-supplied hash cannot substitute a different
-- batch. Claim, manager-only batch execution, deterministic error mapping,
-- and completion are one PostgreSQL transaction.

create extension if not exists pgcrypto with schema extensions;

create or replace function public.reconcile_open_bottles_idempotent(
  p_restaurant_id uuid,
  p_entries jsonb,
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
  v_entry jsonb;
  v_normalized_entry jsonb;
  v_normalized_entries jsonb := '[]'::jsonb;
  v_canonical_entry text;
  v_canonical_entries text := '';
  v_canonical_body text;
  v_computed_hash text;
  v_wine_id uuid;
  v_remaining_ml integer;
  v_note text;
  v_has_note boolean;
  v_entry_count integer;
  v_updated integer;
  v_body jsonb;
  v_status integer;
  v_outcome text;
  v_now timestamptz;
  v_error_message text;
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

  if not public.is_member_with_role(p_restaurant_id, 'manager') then
    raise exception using
      errcode = '42501',
      message = 'forbidden';
  end if;

  if jsonb_typeof(p_entries) <> 'array' then
    raise exception using
      errcode = '22023',
      message = 'entries must be a JSON array';
  end if;

  v_entry_count := jsonb_array_length(p_entries);
  if v_entry_count not between 1 and 100 then
    raise exception using
      errcode = '22023',
      message = 'entries must contain between 1 and 100 items';
  end if;

  -- Rebuild exactly the canonical JSON that createIdempotencyRequestHash()
  -- receives at the route. Array order and duplicates are deliberately kept.
  for v_entry in
    select value
    from jsonb_array_elements(p_entries)
  loop
    if jsonb_typeof(v_entry) <> 'object'
       or not (v_entry ? 'wine_id')
       or not (v_entry ? 'new_remaining_ml')
       or jsonb_typeof(v_entry -> 'wine_id') <> 'string'
       or jsonb_typeof(v_entry -> 'new_remaining_ml') <> 'number'
       or (
         v_entry ? 'note'
         and jsonb_typeof(v_entry -> 'note') <> 'string'
       )
       or exists (
         select 1
         from jsonb_object_keys(v_entry) as entry_key
         where entry_key not in ('wine_id', 'new_remaining_ml', 'note')
       ) then
      raise exception using
        errcode = '22023',
        message = 'invalid reconcile entry';
    end if;

    begin
      v_wine_id := (v_entry ->> 'wine_id')::uuid;
      if (v_entry ->> 'new_remaining_ml')::numeric
           <> trunc((v_entry ->> 'new_remaining_ml')::numeric) then
        raise exception using
          errcode = '22023',
          message = 'new_remaining_ml must be an integer';
      end if;
      v_remaining_ml := (v_entry ->> 'new_remaining_ml')::integer;
    exception
      when invalid_text_representation or numeric_value_out_of_range then
        raise exception using
          errcode = '22023',
          message = 'invalid reconcile entry';
    end;

    if v_remaining_ml not between 0 and 20000 then
      raise exception using
        errcode = '22023',
        message = 'new_remaining_ml is outside the accepted range';
    end if;

    v_has_note := v_entry ? 'note';
    v_note := case
      when v_has_note then regexp_replace(
        v_entry ->> 'note',
        '^\s+|\s+$',
        '',
        'g'
      )
      else null
    end;
    if v_has_note and char_length(v_note) > 500 then
      raise exception using
        errcode = '22023',
        message = 'note exceeds 500 characters';
    end if;

    v_normalized_entry := jsonb_build_object(
      'wine_id', lower(v_wine_id::text),
      'new_remaining_ml', v_remaining_ml
    );
    v_canonical_entry :=
      '{"new_remaining_ml":' || v_remaining_ml::text;

    if v_has_note then
      v_normalized_entry :=
        v_normalized_entry || jsonb_build_object('note', v_note);
      v_canonical_entry :=
        v_canonical_entry || ',"note":' || to_jsonb(v_note)::text;
    end if;

    v_canonical_entry :=
      v_canonical_entry
      || ',"wine_id":'
      || to_jsonb(lower(v_wine_id::text))::text
      || '}';
    v_canonical_entries :=
      v_canonical_entries
      || case when v_canonical_entries = '' then '' else ',' end
      || v_canonical_entry;
    v_normalized_entries :=
      v_normalized_entries || jsonb_build_array(v_normalized_entry);
  end loop;

  v_canonical_body := '{"entries":[' || v_canonical_entries || ']}';
  v_computed_hash := encode(
    extensions.digest(
      decode(
        lpad(to_hex(octet_length(convert_to(v_canonical_body, 'UTF8'))), 16, '0'),
        'hex'
      ) || convert_to(v_canonical_body, 'UTF8'),
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
           or v_claim.operation_id <> 'api:POST:/api/reconcile'
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
        'api:POST:/api/reconcile',
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

  begin
    v_updated := public.reconcile_open_bottles_batch(
      p_restaurant_id,
      v_normalized_entries
    );
    v_outcome := 'reconciled';
    v_status := 200;
    v_body := jsonb_build_object('updated', v_updated);
  exception
    when sqlstate 'P0002' then
      v_outcome := 'exceeds_size';
      v_status := 400;
      v_body := jsonb_build_object(
        'error',
        jsonb_build_object(
          'code', 'EXCEEDS_SIZE',
          'message', 'new_remaining_ml exceeds bottle size.'
        )
      );
    when sqlstate 'P0001' then
      get stacked diagnostics v_error_message = message_text;
      if lower(v_error_message) not in (
        'wine not found',
        'no open bottle for this wine'
      ) then
        raise;
      end if;
      v_outcome := 'not_found';
      v_status := 404;
      v_body := jsonb_build_object(
        'error',
        jsonb_build_object(
          'code', 'not_found',
          'message', 'Open bottle not found.'
        )
      );
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
      and api_idempotency.operation_id = 'api:POST:/api/reconcile'
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
  select v_outcome, v_status, v_body, false, v_started_at;
end;
$$;

revoke all on function public.reconcile_open_bottles_idempotent(
  uuid,
  jsonb,
  text,
  text
) from public;
revoke all on function public.reconcile_open_bottles_idempotent(
  uuid,
  jsonb,
  text,
  text
) from anon;
grant execute on function public.reconcile_open_bottles_idempotent(
  uuid,
  jsonb,
  text,
  text
) to authenticated;

comment on function public.reconcile_open_bottles_idempotent(
  uuid,
  jsonb,
  text,
  text
) is
  'Atomically reconciles one ordered manager batch and stores or replays its exact response.';
