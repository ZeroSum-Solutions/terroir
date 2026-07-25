-- TER-020D17 — atomically create a wine-list item and store its response.
--
-- A generic idempotency claim cannot make the business insert and response
-- completion one transaction. If completion is lost after the insert commits,
-- cleanup can eventually remove the unresolved claim and allow a duplicate
-- item. This dedicated boundary makes claim, section-serialized position
-- allocation, insert, and exact response storage one PostgreSQL transaction.

create or replace function public.create_wine_list_item_idempotent(
  p_restaurant_id uuid,
  p_section_id uuid,
  p_wine_id uuid,
  p_glass_price numeric default null,
  p_bottle_price numeric default null,
  p_name_override text default null,
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
  v_item_id uuid;
  v_next_position integer;
  v_body jsonb;
  v_status integer;
  v_now timestamptz;
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication required';
  end if;

  if p_restaurant_id is null
     or p_section_id is null
     or p_wine_id is null then
    raise exception using
      errcode = '22023',
      message = 'restaurant_id, section_id, and wine_id are required';
  end if;

  if not public.is_member_with_role(p_restaurant_id, 'manager') then
    raise exception using
      errcode = '42501',
      message = 'forbidden';
  end if;

  if p_glass_price is not null and p_glass_price < 0
     or p_bottle_price is not null and p_bottle_price < 0 then
    raise exception using
      errcode = '22023',
      message = 'prices must be nonnegative';
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
                <> 'api:POST:/api/wine-list-items'
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
        'api:POST:/api/wine-list-items',
        p_idempotency_key,
        p_request_hash
      )
      on conflict (user_id, idempotency_key) do nothing;

      if found then
        exit;
      end if;
    end loop;
  end if;

  -- Lock the owned section so concurrent creates allocate distinct positions.
  perform 1
  from public.wine_list_sections section
  join public.wine_lists list on list.id = section.wine_list_id
  where section.id = p_section_id
    and list.restaurant_id = p_restaurant_id
  for update of section;

  if not found then
    v_status := 404;
    v_body := jsonb_build_object(
      'error',
      jsonb_build_object(
        'code', 'not_found',
        'message', 'Section not found.'
      )
    );
    outcome := 'not_found';
  elsif not exists (
    select 1
    from public.wines wine
    where wine.id = p_wine_id
      and wine.restaurant_id = p_restaurant_id
  ) then
    v_status := 404;
    v_body := jsonb_build_object(
      'error',
      jsonb_build_object(
        'code', 'not_found',
        'message', 'Wine not found.'
      )
    );
    outcome := 'not_found';
  else
    select coalesce(max(item.position), -1) + 1
    into v_next_position
    from public.wine_list_items item
    where item.section_id = p_section_id;

    insert into public.wine_list_items (
      section_id,
      wine_id,
      position,
      glass_price,
      bottle_price,
      name_override
    ) values (
      p_section_id,
      p_wine_id,
      v_next_position,
      p_glass_price,
      p_bottle_price,
      p_name_override
    )
    returning id into v_item_id;

    v_status := 200;
    v_body := jsonb_build_object('id', v_item_id);
    outcome := 'created';
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
            = 'api:POST:/api/wine-list-items'
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
  select outcome, v_status, v_body, false;
end;
$$;

revoke all on function public.create_wine_list_item_idempotent(
  uuid,
  uuid,
  uuid,
  numeric,
  numeric,
  text,
  text,
  text
) from public;
revoke all on function public.create_wine_list_item_idempotent(
  uuid,
  uuid,
  uuid,
  numeric,
  numeric,
  text,
  text,
  text
) from anon;
grant execute on function public.create_wine_list_item_idempotent(
  uuid,
  uuid,
  uuid,
  numeric,
  numeric,
  text,
  text,
  text
) to authenticated;

comment on function public.create_wine_list_item_idempotent(
  uuid,
  uuid,
  uuid,
  numeric,
  numeric,
  text,
  text,
  text
) is
  'Atomically creates one wine-list item and stores or replays its exact keyed response.';
