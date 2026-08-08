-- TER-025 / TER-CF-073..074 — atomic, reasoned cellar quantity adjustments.

create extension if not exists pgcrypto with schema extensions;

alter table public.availability_events
  drop constraint availability_events_direction_check;

alter table public.availability_events
  add constraint availability_events_direction_check
    check (direction in ('eightysixed', 'restored', 'reconcile', 'adjustment'));

comment on column public.availability_events.delta is
  'Reconcile: old_remaining_ml - new_remaining_ml. Adjustment: new bottle quantity - old bottle quantity. Null for 86/restore events.';

create or replace function public.adjust_cellar_quantity_idempotent(
  p_restaurant_id uuid,
  p_wine_id uuid,
  p_quantity integer,
  p_reason text,
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
  v_current integer;
  v_remaining integer;
  v_take integer;
  v_item public.inventory_items%rowtype;
  v_body jsonb;
  v_completed boolean;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;
  if p_restaurant_id is null or p_wine_id is null
     or p_quantity is null or p_quantity not between 0 and 100000
     or p_reason is null or p_reason <> btrim(p_reason)
     or char_length(p_reason) not between 1 and 500 then
    raise exception using errcode = '22023', message = 'invalid cellar quantity adjustment input';
  end if;
  if not public.is_member_with_role(p_restaurant_id, 'manager') then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;

  v_identity := '{"id":' || pg_catalog.to_json(p_wine_id::text)::text
    || ',"quantity":' || pg_catalog.to_json(p_quantity)::text
    || ',"reason":' || pg_catalog.to_json(p_reason)::text || '}';
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
      raise exception using errcode = '22023', message = 'request hash does not match the canonical quantity adjustment identity';
    end if;
    select * into v_claim from public.claim_api_idempotency(
      p_restaurant_id,
      'api:PATCH:/api/cellar/{param}/quantity',
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

  perform 1 from public.wines
    where id = p_wine_id and restaurant_id = p_restaurant_id
    for update;
  if not found then
    v_body := jsonb_build_object('error', jsonb_build_object('code', 'not_found', 'message', 'Wine not found.'));
    if p_idempotency_key is not null then
      v_completed := public.complete_api_idempotency(p_restaurant_id, 'api:PATCH:/api/cellar/{param}/quantity', p_idempotency_key, v_computed_hash, 404, '{}'::jsonb, v_body);
      if not v_completed then raise exception using errcode = '40001', message = 'idempotency completion changed concurrently'; end if;
    end if;
    return query select 'not_found'::text, 404, v_body, false;
    return;
  end if;

  perform 1 from public.inventory_items
    where wine_id = p_wine_id and restaurant_id = p_restaurant_id
    for update;
  select coalesce(sum(quantity), 0)::integer into v_current
    from public.inventory_items
    where wine_id = p_wine_id and restaurant_id = p_restaurant_id;

  if p_quantity > v_current then
    select * into v_item
      from public.inventory_items
      where wine_id = p_wine_id and restaurant_id = p_restaurant_id
      order by added_at desc, id
      limit 1;
    if found then
      update public.inventory_items
        set quantity = quantity + (p_quantity - v_current), updated_at = now()
        where id = v_item.id and restaurant_id = p_restaurant_id;
    else
      insert into public.inventory_items (
        wine_id, restaurant_id, quantity, unit_cost, added_via, format
      ) values (
        p_wine_id, p_restaurant_id, p_quantity, 0, 'manual', '750ml'
      );
    end if;
  elsif p_quantity < v_current then
    v_remaining := v_current - p_quantity;
    for v_item in
      select * from public.inventory_items
      where wine_id = p_wine_id and restaurant_id = p_restaurant_id and quantity > 0
      order by added_at desc, id
    loop
      exit when v_remaining = 0;
      v_take := least(v_item.quantity, v_remaining);
      update public.inventory_items
        set quantity = quantity - v_take, updated_at = now()
        where id = v_item.id and restaurant_id = p_restaurant_id;
      v_remaining := v_remaining - v_take;
    end loop;
  end if;

  if p_quantity <> v_current then
    insert into public.availability_events (
      wine_id, restaurant_id, direction, delta, user_id, note
    ) values (
      p_wine_id, p_restaurant_id, 'adjustment', p_quantity - v_current, v_user_id, p_reason
    );
  end if;

  v_body := jsonb_build_object(
    'wineId', p_wine_id,
    'quantity', p_quantity,
    'previousQuantity', v_current,
    'delta', p_quantity - v_current,
    'reason', p_reason
  );
  if p_idempotency_key is not null then
    v_completed := public.complete_api_idempotency(
      p_restaurant_id,
      'api:PATCH:/api/cellar/{param}/quantity',
      p_idempotency_key,
      v_computed_hash,
      200,
      '{}'::jsonb,
      v_body
    );
    if not v_completed then raise exception using errcode = '40001', message = 'idempotency completion changed concurrently'; end if;
  end if;

  return query select case when p_quantity = v_current then 'unchanged' else 'adjusted' end, 200, v_body, false;
end;
$$;

revoke all on function public.adjust_cellar_quantity_idempotent(uuid,uuid,integer,text,text,text) from public;
revoke all on function public.adjust_cellar_quantity_idempotent(uuid,uuid,integer,text,text,text) from anon;
grant execute on function public.adjust_cellar_quantity_idempotent(uuid,uuid,integer,text,text,text) to authenticated;
