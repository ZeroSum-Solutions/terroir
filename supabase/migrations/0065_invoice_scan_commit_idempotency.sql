-- Migration 0065 / TER-020D18 — commit one invoice scan and its idempotency response in the
-- same transaction. The scan row lock serializes commits while the shared
-- per-user key claim prevents a lost HTTP response from duplicating inventory.

create extension if not exists pgcrypto with schema extensions;

create or replace function public.commit_invoice_scan_idempotent(
  p_restaurant_id uuid,
  p_scan_id uuid,
  p_idempotency_key text default null,
  p_request_hash text default null
) returns table (
  outcome text,
  response_status integer,
  response_body jsonb,
  replayed boolean,
  wine_ids uuid[]
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_claim record;
  v_scan public.invoice_scans%rowtype;
  v_items jsonb;
  v_wines jsonb;
  v_wine_ids uuid[];
  v_wine_count integer;
  v_identity text;
  v_computed_hash text;
  v_body jsonb;
  v_completed boolean;
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication required';
  end if;

  if p_restaurant_id is null or p_scan_id is null then
    raise exception using
      errcode = '22023',
      message = 'restaurant_id and scan_id are required';
  end if;

  if not public.is_member_with_role(p_restaurant_id, 'staff') then
    raise exception using
      errcode = '42501',
      message = 'forbidden';
  end if;

  -- createIdempotencyRequestHash({ id }) sorts the single key and frames the
  -- UTF-8 canonical JSON with an eight-byte big-endian length.
  v_identity :=
    '{"id":' || pg_catalog.to_json(p_scan_id::text)::text || '}';
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
    if p_request_hash is null or p_request_hash <> v_computed_hash then
      raise exception using
        errcode = '22023',
        message = 'request hash does not match the canonical scan identity';
    end if;

    select *
    into v_claim
    from public.claim_api_idempotency(
      p_restaurant_id,
      'api:POST:/api/scans/{param}/commit',
      p_idempotency_key,
      v_computed_hash
    );

    if v_claim.outcome = 'replay' then
      return query
      select
        'replay'::text,
        v_claim.response_status,
        v_claim.response_body,
        true,
        null::uuid[];
      return;
    elsif v_claim.outcome = 'in_progress' then
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
        null::uuid[];
      return;
    elsif v_claim.outcome = 'mismatch' then
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
        null::uuid[];
      return;
    elsif v_claim.outcome = 'expired' then
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
        null::uuid[];
      return;
    elsif v_claim.outcome = 'outcome_unknown' then
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
        null::uuid[];
      return;
    elsif v_claim.outcome <> 'claimed' then
      raise exception using
        errcode = '40001',
        message = 'unexpected idempotency claim outcome';
    end if;
  end if;

  select *
  into v_scan
  from public.invoice_scans
  where invoice_scans.id = p_scan_id
    and invoice_scans.restaurant_id = p_restaurant_id
  for update;

  if not found then
    v_body := jsonb_build_object(
      'error',
      jsonb_build_object(
        'code', 'not_found',
        'message', 'Scan not found.'
      )
    );
    if p_idempotency_key is not null then
      v_completed := public.complete_api_idempotency(
        p_restaurant_id,
        'api:POST:/api/scans/{param}/commit',
        p_idempotency_key,
        v_computed_hash,
        404,
        '{}'::jsonb,
        v_body
      );
      if not v_completed then
        raise exception using
          errcode = '40001',
          message = 'idempotency completion changed concurrently';
      end if;
    end if;
    return query
    select 'not_found'::text, 404, v_body, false, null::uuid[];
    return;
  end if;

  v_items := v_scan.final_line_items;
  if jsonb_typeof(v_items) is distinct from 'array'
     or jsonb_array_length(v_items) = 0
     or exists (
       select 1
       from jsonb_array_elements(v_items) as entry(item)
       where jsonb_typeof(item) is distinct from 'object'
         or jsonb_typeof(item -> 'id') is distinct from 'string'
         or jsonb_typeof(item -> 'name') is distinct from 'string'
         or jsonb_typeof(item -> 'producer') is distinct from 'string'
         or jsonb_typeof(item -> 'varietal') is distinct from 'string'
         or jsonb_typeof(item -> 'region') is distinct from 'string'
         or jsonb_typeof(item -> 'qty') is distinct from 'number'
         or case
           when jsonb_typeof(item -> 'qty') = 'number' then
             (item ->> 'qty')::numeric
               <> trunc((item ->> 'qty')::numeric)
             or (item ->> 'qty')::numeric <= 0
             or (item ->> 'qty')::numeric > 2147483647
           else false
         end
         or jsonb_typeof(item -> 'unitCost') is distinct from 'number'
         or case
           when jsonb_typeof(item -> 'unitCost') = 'number' then
             (item ->> 'unitCost')::numeric < 0
           else false
         end
         or jsonb_typeof(item -> 'confidence') is distinct from 'number'
         or case
           when jsonb_typeof(item -> 'confidence') = 'number' then
             (item ->> 'confidence')::numeric < 0
             or (item ->> 'confidence')::numeric > 1
           else false
         end
         or (
           jsonb_typeof(item -> 'vintage') is distinct from 'number'
           and jsonb_typeof(item -> 'vintage') is distinct from 'null'
         )
         or case
           when jsonb_typeof(item -> 'vintage') = 'number' then
             (item ->> 'vintage')::numeric
               <> trunc((item ->> 'vintage')::numeric)
             or (item ->> 'vintage')::numeric
               not between -2147483648 and 2147483647
           else false
         end
         or (
           item ? 'currency'
           and jsonb_typeof(item -> 'currency')
             not in ('string', 'null')
         )
         or (
           item ? 'format'
           and jsonb_typeof(item -> 'format')
             not in ('string', 'null')
         )
         or case
           when not (item ? 'lowFields') then false
           when jsonb_typeof(item -> 'lowFields') <> 'array' then true
           else exists (
               select 1
               from jsonb_array_elements_text(item -> 'lowFields')
                 as low_field(value)
               where value not in (
                 'name',
                 'producer',
                 'vintage',
                 'varietal',
                 'region',
                 'qty',
                 'unitCost',
                 'currency',
                 'format'
               )
             )
         end
     ) then
    v_body := jsonb_build_object(
      'error',
      jsonb_build_object(
        'code', 'bad_request',
        'message', 'Scan has no valid line items to commit.'
      )
    );
    if p_idempotency_key is not null then
      v_completed := public.complete_api_idempotency(
        p_restaurant_id,
        'api:POST:/api/scans/{param}/commit',
        p_idempotency_key,
        v_computed_hash,
        400,
        '{}'::jsonb,
        v_body
      );
      if not v_completed then
        raise exception using
          errcode = '40001',
          message = 'idempotency completion changed concurrently';
      end if;
    end if;
    return query
    select 'invalid_scan'::text, 400, v_body, false, null::uuid[];
    return;
  end if;

  select jsonb_agg(
    jsonb_build_object(
      'name', item ->> 'name',
      'producer', item ->> 'producer',
      'vintage', item -> 'vintage',
      'varietal', nullif(item ->> 'varietal', ''),
      'region', nullif(item ->> 'region', ''),
      'country', null,
      'size_ml', 750
    )
    order by ordinal
  )
  into v_wines
  from jsonb_array_elements(v_items) with ordinality
    as entries(item, ordinal);

  v_wine_ids := public.find_or_create_wines_batch(
    p_restaurant_id,
    v_wines
  );

  if cardinality(v_wine_ids) <> jsonb_array_length(v_items)
     or array_position(v_wine_ids, null) is not null then
    raise exception using
      errcode = 'P0001',
      message = 'find_or_create_wines_batch returned invalid IDs';
  end if;

  insert into public.inventory_items (
    wine_id,
    restaurant_id,
    invoice_scan_id,
    quantity,
    unit_cost,
    format,
    currency,
    added_via
  )
  select
    v_wine_ids[ordinal::integer],
    p_restaurant_id,
    p_scan_id,
    (item ->> 'qty')::integer,
    (item ->> 'unitCost')::numeric,
    item ->> 'format',
    item ->> 'currency',
    'invoice_scan'::public.added_via
  from jsonb_array_elements(v_items) with ordinality
    as entries(item, ordinal);

  select count(distinct wine_id)::integer
  into v_wine_count
  from unnest(v_wine_ids) as committed(wine_id);

  v_body := jsonb_build_object(
    'scanId', p_scan_id,
    'itemCount', jsonb_array_length(v_items),
    'wineCount', v_wine_count
  );

  if p_idempotency_key is not null then
    v_completed := public.complete_api_idempotency(
      p_restaurant_id,
      'api:POST:/api/scans/{param}/commit',
      p_idempotency_key,
      v_computed_hash,
      200,
      '{}'::jsonb,
      v_body
    );
    if not v_completed then
      raise exception using
        errcode = '40001',
        message = 'idempotency completion changed concurrently';
    end if;
  end if;

  return query
  select 'committed'::text, 200, v_body, false, v_wine_ids;
end;
$$;

revoke all on function public.commit_invoice_scan_idempotent(
  uuid,
  uuid,
  text,
  text
) from public;
revoke all on function public.commit_invoice_scan_idempotent(
  uuid,
  uuid,
  text,
  text
) from anon;
grant execute on function public.commit_invoice_scan_idempotent(
  uuid,
  uuid,
  text,
  text
) to authenticated;

comment on function public.commit_invoice_scan_idempotent(
  uuid,
  uuid,
  text,
  text
) is
  'Atomically creates wines and invoice inventory while storing or replaying the exact keyed API response.';
