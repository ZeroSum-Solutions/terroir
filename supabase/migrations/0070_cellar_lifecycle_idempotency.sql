-- TER-020D23 — make the remaining cellar lifecycle mutations retry-safe.
--
-- The previous handlers claimed and mutated through separate HTTP/database
-- calls. These commands commit the claim, cellar write, and exact response in
-- one transaction, so a retry after a lost response cannot duplicate inventory
-- or repeat a wine deletion.

create extension if not exists pgcrypto with schema extensions;

create or replace function public.add_cellar_wine_idempotent(
  p_restaurant_id uuid,
  p_name text,
  p_producer text,
  p_vintage integer default null,
  p_varietal text default null,
  p_region text default null,
  p_country text default null,
  p_quantity integer default 1,
  p_unit_cost numeric default 0,
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
  v_claim record;
  v_identity text;
  v_computed_hash text;
  v_wine_ids uuid[];
  v_wine_id uuid;
  v_inventory public.inventory_items%rowtype;
  v_body jsonb;
  v_completed boolean;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;

  if p_restaurant_id is null
     or p_name is null or p_name <> btrim(p_name)
     or char_length(p_name) not between 1 and 200
     or p_producer is null or p_producer <> btrim(p_producer)
     or char_length(p_producer) not between 1 and 200
     or (p_vintage is not null and p_vintage not between 1900 and 2100)
     or (p_varietal is not null and (
       p_varietal <> btrim(p_varietal) or char_length(p_varietal) > 100
     ))
     or (p_region is not null and (
       p_region <> btrim(p_region) or char_length(p_region) > 100
     ))
     or (p_country is not null and (
       p_country <> btrim(p_country) or char_length(p_country) > 100
     ))
     or p_quantity is null or p_quantity not between 1 and 100000
     or p_unit_cost is null or p_unit_cost < 0 or p_unit_cost > 99999999.99 then
    raise exception using errcode = '22023', message = 'invalid cellar add input';
  end if;

  if not public.is_member_with_role(p_restaurant_id, 'manager') then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;

  -- This mirrors createIdempotencyRequestHash({ body }) exactly: sorted JSON
  -- fields with an eight-byte big-endian UTF-8 length prefix.
  v_identity :=
    '{"body":{"country":' || coalesce(pg_catalog.to_json(p_country)::text, 'null')
    || ',"name":' || pg_catalog.to_json(p_name)::text
    || ',"producer":' || pg_catalog.to_json(p_producer)::text
    || ',"quantity":' || pg_catalog.to_json(p_quantity)::text
    || ',"region":' || coalesce(pg_catalog.to_json(p_region)::text, 'null')
    || ',"unit_cost":' || pg_catalog.to_json(p_unit_cost)::text
    || ',"varietal":' || coalesce(pg_catalog.to_json(p_varietal)::text, 'null')
    || ',"vintage":' || coalesce(pg_catalog.to_json(p_vintage)::text, 'null')
    || '}}';
  v_computed_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.int8send(
        pg_catalog.octet_length(pg_catalog.convert_to(v_identity, 'UTF8'))::bigint
      ) || pg_catalog.convert_to(v_identity, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  if p_idempotency_key is null and p_request_hash is not null then
    raise exception using errcode = '22023', message = 'request hash requires an idempotency key';
  end if;

  if p_idempotency_key is not null then
    if p_request_hash is null or p_request_hash <> v_computed_hash then
      raise exception using errcode = '22023', message = 'request hash does not match the canonical cellar add identity';
    end if;

    select * into v_claim from public.claim_api_idempotency(
      p_restaurant_id,
      'api:POST:/api/cellar',
      p_idempotency_key,
      v_computed_hash
    );
    if v_claim.outcome = 'replay' then
      return query select 'replay'::text, v_claim.response_status, v_claim.response_body, true;
      return;
    elsif v_claim.outcome = 'in_progress' then
      return query select 'idempotency_in_progress'::text, 409,
        jsonb_build_object('error', jsonb_build_object(
          'code', 'idempotency_in_progress',
          'message', 'A request with this Idempotency-Key is still in progress.'
        )), false;
      return;
    elsif v_claim.outcome = 'mismatch' then
      return query select 'idempotency_key_reused'::text, 409,
        jsonb_build_object('error', jsonb_build_object(
          'code', 'idempotency_key_reused',
          'message', 'This Idempotency-Key was already used for a different request.'
        )), false;
      return;
    elsif v_claim.outcome = 'expired' then
      return query select 'idempotency_key_expired'::text, 409,
        jsonb_build_object('error', jsonb_build_object(
          'code', 'idempotency_key_expired',
          'message', 'This Idempotency-Key has expired.'
        )), false;
      return;
    elsif v_claim.outcome = 'outcome_unknown' then
      return query select 'idempotency_outcome_unknown'::text, 409,
        jsonb_build_object('error', jsonb_build_object(
          'code', 'idempotency_outcome_unknown',
          'message', 'The original request outcome is unknown and will not be retried.'
        )), false;
      return;
    elsif v_claim.outcome <> 'claimed' then
      raise exception using errcode = '40001', message = 'unexpected idempotency claim outcome';
    end if;
  end if;

  v_wine_ids := public.find_or_create_wines_batch(
    p_restaurant_id,
    jsonb_build_array(jsonb_build_object(
      'name', p_name,
      'producer', p_producer,
      'vintage', p_vintage,
      'varietal', p_varietal,
      'region', p_region,
      'country', p_country,
      'size_ml', 750
    ))
  );
  v_wine_id := v_wine_ids[1];
  if cardinality(v_wine_ids) <> 1 or v_wine_id is null then
    raise exception using errcode = 'P0001', message = 'find_or_create_wines_batch returned invalid IDs';
  end if;

  insert into public.inventory_items (
    wine_id, restaurant_id, quantity, unit_cost, added_via
  ) values (
    v_wine_id, p_restaurant_id, p_quantity, p_unit_cost, 'manual'
  ) returning * into v_inventory;

  v_body := jsonb_build_object(
    'wineId', v_wine_id,
    'inventoryId', v_inventory.id,
    'quantity', v_inventory.quantity,
    'unitCost', v_inventory.unit_cost
  );
  if p_idempotency_key is not null then
    v_completed := public.complete_api_idempotency(
      p_restaurant_id,
      'api:POST:/api/cellar',
      p_idempotency_key,
      v_computed_hash,
      200,
      '{}'::jsonb,
      v_body
    );
    if not v_completed then
      raise exception using errcode = '40001', message = 'idempotency completion changed concurrently';
    end if;
  end if;

  return query select 'added'::text, 200, v_body, false;
end;
$$;

create or replace function public.delete_cellar_wine_idempotent(
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
  v_claim record;
  v_wine public.wines%rowtype;
  v_identity text;
  v_computed_hash text;
  v_count bigint;
  v_body jsonb;
  v_completed boolean;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;
  if p_restaurant_id is null or p_wine_id is null then
    raise exception using errcode = '22023', message = 'restaurant_id and wine_id are required';
  end if;
  if not public.is_member_with_role(p_restaurant_id, 'owner') then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;

  v_identity := '{"id":' || pg_catalog.to_json(p_wine_id::text)::text || '}';
  v_computed_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.int8send(
        pg_catalog.octet_length(pg_catalog.convert_to(v_identity, 'UTF8'))::bigint
      ) || pg_catalog.convert_to(v_identity, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
  if p_idempotency_key is null and p_request_hash is not null then
    raise exception using errcode = '22023', message = 'request hash requires an idempotency key';
  end if;
  if p_idempotency_key is not null then
    if p_request_hash is null or p_request_hash <> v_computed_hash then
      raise exception using errcode = '22023', message = 'request hash does not match the canonical cellar deletion identity';
    end if;
    select * into v_claim from public.claim_api_idempotency(
      p_restaurant_id,
      'api:DELETE:/api/cellar/{param}',
      p_idempotency_key,
      v_computed_hash
    );
    if v_claim.outcome = 'replay' then
      return query select 'replay'::text, v_claim.response_status, v_claim.response_body, true;
      return;
    elsif v_claim.outcome = 'in_progress' then
      return query select 'idempotency_in_progress'::text, 409,
        jsonb_build_object('error', jsonb_build_object('code', 'idempotency_in_progress', 'message', 'A request with this Idempotency-Key is still in progress.')), false;
      return;
    elsif v_claim.outcome = 'mismatch' then
      return query select 'idempotency_key_reused'::text, 409,
        jsonb_build_object('error', jsonb_build_object('code', 'idempotency_key_reused', 'message', 'This Idempotency-Key was already used for a different request.')), false;
      return;
    elsif v_claim.outcome = 'expired' then
      return query select 'idempotency_key_expired'::text, 409,
        jsonb_build_object('error', jsonb_build_object('code', 'idempotency_key_expired', 'message', 'This Idempotency-Key has expired.')), false;
      return;
    elsif v_claim.outcome = 'outcome_unknown' then
      return query select 'idempotency_outcome_unknown'::text, 409,
        jsonb_build_object('error', jsonb_build_object('code', 'idempotency_outcome_unknown', 'message', 'The original request outcome is unknown and will not be retried.')), false;
      return;
    elsif v_claim.outcome <> 'claimed' then
      raise exception using errcode = '40001', message = 'unexpected idempotency claim outcome';
    end if;
  end if;

  -- FOR UPDATE blocks new FK references while the dependency checks and delete
  -- execute, preventing a check-then-delete race.
  select * into v_wine
  from public.wines
  where wines.id = p_wine_id and wines.restaurant_id = p_restaurant_id
  for update;
  if not found then
    v_body := jsonb_build_object('error', jsonb_build_object('code', 'not_found', 'message', 'Wine not found.'));
    if p_idempotency_key is not null then
      v_completed := public.complete_api_idempotency(p_restaurant_id, 'api:DELETE:/api/cellar/{param}', p_idempotency_key, v_computed_hash, 404, '{}'::jsonb, v_body);
      if not v_completed then raise exception using errcode = '40001', message = 'idempotency completion changed concurrently'; end if;
    end if;
    return query select 'not_found'::text, 404, v_body, false;
    return;
  end if;

  select count(*) into v_count from public.pour_events
  where pour_events.wine_id = p_wine_id and pour_events.restaurant_id = p_restaurant_id;
  if v_count > 0 then
    v_body := jsonb_build_object('error', jsonb_build_object('code', 'wine_has_pours', 'message', format('Cannot delete "%s %s" — it has %s pour event%s.', v_wine.producer, v_wine.name, v_count, case when v_count = 1 then '' else 's' end)));
    return query select * from public.complete_cellar_wine_delete_idempotency(p_restaurant_id, p_idempotency_key, v_computed_hash, 'wine_has_pours', v_body);
    return;
  end if;

  select count(*) into v_count from public.inventory_items
  where inventory_items.wine_id = p_wine_id and inventory_items.restaurant_id = p_restaurant_id;
  if v_count > 0 then
    v_body := jsonb_build_object('error', jsonb_build_object('code', 'wine_has_inventory', 'message', format('Cannot delete "%s %s" — it has %s inventory item%s. 86 the wine instead.', v_wine.producer, v_wine.name, v_count, case when v_count = 1 then '' else 's' end)));
    return query select * from public.complete_cellar_wine_delete_idempotency(p_restaurant_id, p_idempotency_key, v_computed_hash, 'wine_has_inventory', v_body);
    return;
  end if;

  select count(*) into v_count from public.wine_list_items
  where wine_list_items.wine_id = p_wine_id;
  if v_count > 0 then
    v_body := jsonb_build_object('error', jsonb_build_object('code', 'wine_on_lists', 'message', format('Cannot delete "%s %s" — it appears on %s wine list%s. Remove it from lists first.', v_wine.producer, v_wine.name, v_count, case when v_count = 1 then '' else 's' end)));
    return query select * from public.complete_cellar_wine_delete_idempotency(p_restaurant_id, p_idempotency_key, v_computed_hash, 'wine_on_lists', v_body);
    return;
  end if;

  select count(*) into v_count from public.invoice_scans
  where invoice_scans.restaurant_id = p_restaurant_id
    and invoice_scans.parsed_line_items @> jsonb_build_array(jsonb_build_object('name', v_wine.name));
  if v_count > 0 then
    v_body := jsonb_build_object('error', jsonb_build_object('code', 'wine_from_scan', 'message', format('Cannot delete "%s %s" — it was imported via %s invoice scan%s. Remove the scan record first.', v_wine.producer, v_wine.name, v_count, case when v_count = 1 then '' else 's' end)));
    return query select * from public.complete_cellar_wine_delete_idempotency(p_restaurant_id, p_idempotency_key, v_computed_hash, 'wine_from_scan', v_body);
    return;
  end if;

  delete from public.wines where wines.id = p_wine_id and wines.restaurant_id = p_restaurant_id;
  if not found then
    raise exception using errcode = '40001', message = 'cellar deletion target changed concurrently';
  end if;
  v_body := jsonb_build_object('deleted', true);
  if p_idempotency_key is not null then
    v_completed := public.complete_api_idempotency(p_restaurant_id, 'api:DELETE:/api/cellar/{param}', p_idempotency_key, v_computed_hash, 200, '{}'::jsonb, v_body);
    if not v_completed then raise exception using errcode = '40001', message = 'idempotency completion changed concurrently'; end if;
  end if;
  return query select 'deleted'::text, 200, v_body, false;
end;
$$;

-- Complete deterministic deletion denials inside the same transaction as the
-- claim. The helper preserves the keyless legacy responses without a record.
create or replace function public.complete_cellar_wine_delete_idempotency(
  p_restaurant_id uuid,
  p_idempotency_key text,
  p_request_hash text,
  p_outcome text,
  p_response_body jsonb
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
  v_completed boolean;
begin
  if p_idempotency_key is not null then
    v_completed := public.complete_api_idempotency(
      p_restaurant_id, 'api:DELETE:/api/cellar/{param}', p_idempotency_key,
      p_request_hash, 409, '{}'::jsonb, p_response_body
    );
    if not v_completed then
      raise exception using errcode = '40001', message = 'idempotency completion changed concurrently';
    end if;
  end if;
  return query select p_outcome, 409, p_response_body, false;
end;
$$;

revoke all on function public.add_cellar_wine_idempotent(uuid,text,text,integer,text,text,text,integer,numeric,text,text) from public;
revoke all on function public.add_cellar_wine_idempotent(uuid,text,text,integer,text,text,text,integer,numeric,text,text) from anon;
grant execute on function public.add_cellar_wine_idempotent(uuid,text,text,integer,text,text,text,integer,numeric,text,text) to authenticated;
revoke all on function public.delete_cellar_wine_idempotent(uuid,uuid,text,text) from public;
revoke all on function public.delete_cellar_wine_idempotent(uuid,uuid,text,text) from anon;
grant execute on function public.delete_cellar_wine_idempotent(uuid,uuid,text,text) to authenticated;
revoke all on function public.complete_cellar_wine_delete_idempotency(uuid,text,text,text,jsonb) from public;
revoke all on function public.complete_cellar_wine_delete_idempotency(uuid,text,text,text,jsonb) from anon;

comment on function public.add_cellar_wine_idempotent(uuid,text,text,integer,text,text,text,integer,numeric,text,text) is
  'Atomically adds cellar inventory and stores or replays the exact keyed API response.';
comment on function public.delete_cellar_wine_idempotent(uuid,uuid,text,text) is
  'Atomically deletes an unreferenced cellar wine and stores or replays exact keyed outcomes.';
