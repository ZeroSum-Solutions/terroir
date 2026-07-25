-- TER-020D22 — make wine-list cloning and publication atomically retry-safe.
--
-- Clone allocates a list plus section and item UUIDs. Publish can allocate a
-- public slug. These functions commit each business result and its exact HTTP
-- response in one transaction so a lost response cannot duplicate a clone or
-- change the public URL on retry.

create extension if not exists pgcrypto with schema extensions;

create or replace function public.clone_wine_list_idempotent(
  p_restaurant_id uuid,
  p_wine_list_id uuid,
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
  v_source public.wine_lists%rowtype;
  v_clone_id uuid;
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

  if p_restaurant_id is null or p_wine_list_id is null then
    raise exception using
      errcode = '22023',
      message = 'restaurant_id and wine_list_id are required';
  end if;

  if not public.is_member_with_role(p_restaurant_id, 'manager') then
    raise exception using
      errcode = '42501',
      message = 'forbidden';
  end if;

  v_identity :=
    '{"id":'
    || pg_catalog.to_json(p_wine_list_id::text)::text
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
    if p_request_hash is null or p_request_hash <> v_computed_hash then
      raise exception using
        errcode = '22023',
        message = 'request hash does not match the canonical clone identity';
    end if;

    select *
    into v_claim
    from public.claim_api_idempotency(
      p_restaurant_id,
      'api:POST:/api/wine-lists/{param}/clone',
      p_idempotency_key,
      v_computed_hash
    );

    if v_claim.outcome = 'replay' then
      return query
      select
        'replay'::text,
        v_claim.response_status,
        v_claim.response_body,
        true;
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
        false;
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
        false;
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
        false;
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
        false;
      return;
    elsif v_claim.outcome is distinct from 'claimed' then
      raise exception using
        errcode = '40001',
        message = 'unexpected idempotency claim outcome';
    end if;
  end if;

  select list.*
  into v_source
  from public.wine_lists list
  where list.id = p_wine_list_id
    and list.restaurant_id = p_restaurant_id
  for share;

  if not found then
    v_body := jsonb_build_object(
      'error',
      jsonb_build_object(
        'code', 'not_found',
        'message', 'Wine list not found.'
      )
    );
    if p_idempotency_key is not null then
      v_completed := public.complete_api_idempotency(
        p_restaurant_id,
        'api:POST:/api/wine-lists/{param}/clone',
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
    select 'not_found'::text, 404, v_body, false;
    return;
  end if;

  insert into public.wine_lists (
    restaurant_id,
    name,
    description,
    template,
    slug,
    is_published,
    archived
  ) values (
    p_restaurant_id,
    v_source.name || ' (copy)',
    v_source.description,
    v_source.template,
    null,
    false,
    false
  )
  returning id into v_clone_id;

  -- Allocate the section mapping and copy every descendant in one statement.
  -- Every CTE reads one READ COMMITTED snapshot, so a concurrent direct table
  -- insert/update/delete is either wholly before or wholly after this clone.
  with section_map as materialized (
    select
      section.id as source_section_id,
      extensions.gen_random_uuid() as clone_section_id,
      section.name,
      section.position
    from public.wine_list_sections section
    where section.wine_list_id = p_wine_list_id
  ),
  inserted_sections as (
    insert into public.wine_list_sections (
      id,
      wine_list_id,
      name,
      position
    )
    select
      map.clone_section_id,
      v_clone_id,
      map.name,
      map.position
    from section_map map
    order by map.position, map.source_section_id
    returning id
  )
  insert into public.wine_list_items (
    section_id,
    wine_id,
    bottle_price,
    glass_price,
    glass_pour_ml,
    pour_size_mode,
    position,
    is_available,
    tasting_note,
    name_override,
    blurb,
    hidden
  )
  select
    map.clone_section_id,
    item.wine_id,
    item.bottle_price,
    item.glass_price,
    item.glass_pour_ml,
    item.pour_size_mode,
    item.position,
    item.is_available,
    item.tasting_note,
    item.name_override,
    item.blurb,
    item.hidden
  from section_map map
  join inserted_sections inserted
    on inserted.id = map.clone_section_id
  join public.wine_list_items item
    on item.section_id = map.source_section_id
  order by map.position, map.source_section_id, item.position, item.id;

  v_body := jsonb_build_object('id', v_clone_id);
  if p_idempotency_key is not null then
    v_completed := public.complete_api_idempotency(
      p_restaurant_id,
      'api:POST:/api/wine-lists/{param}/clone',
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
  select 'cloned'::text, 200, v_body, false;
end;
$$;

create or replace function public.set_wine_list_publication_idempotent(
  p_restaurant_id uuid,
  p_wine_list_id uuid,
  p_publish boolean,
  p_has_slug boolean default false,
  p_slug text default null,
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
  v_list public.wine_lists%rowtype;
  v_operation_id text;
  v_identity text;
  v_computed_hash text;
  v_slug text;
  v_slug_source text;
  v_restaurant_name text;
  v_generated_slug boolean := false;
  v_slug_attempt integer := 0;
  v_body jsonb;
  v_completed boolean;
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication required';
  end if;

  if p_restaurant_id is null
     or p_wine_list_id is null
     or p_publish is null
     or p_has_slug is null then
    raise exception using
      errcode = '22023',
      message = 'restaurant_id, wine_list_id, publish, and has_slug are required';
  end if;

  if not public.is_member_with_role(p_restaurant_id, 'manager') then
    raise exception using
      errcode = '42501',
      message = 'forbidden';
  end if;

  if p_publish then
    if p_has_slug then
      if p_slug is null
         or char_length(p_slug) > 50
         or p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
        raise exception using
          errcode = '22023',
          message = 'invalid publication slug';
      end if;
    elsif p_slug is not null then
      raise exception using
        errcode = '22023',
        message = 'slug requires has_slug';
    end if;
    v_operation_id := 'api:POST:/api/wine-lists/{param}/publish';
    v_identity :=
      '{"body":'
      || case
        when p_has_slug then
          '{"slug":' || pg_catalog.to_json(p_slug)::text || '}'
        else '{}'
      end
      || ',"id":'
      || pg_catalog.to_json(p_wine_list_id::text)::text
      || '}';
  else
    if p_has_slug or p_slug is not null then
      raise exception using
        errcode = '22023',
        message = 'unpublish does not accept a slug';
    end if;
    v_operation_id := 'api:DELETE:/api/wine-lists/{param}/publish';
    v_identity :=
      '{"id":'
      || pg_catalog.to_json(p_wine_list_id::text)::text
      || '}';
  end if;

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
        message = 'request hash does not match publication identity';
    end if;

    select *
    into v_claim
    from public.claim_api_idempotency(
      p_restaurant_id,
      v_operation_id,
      p_idempotency_key,
      v_computed_hash
    );

    if v_claim.outcome = 'replay' then
      return query
      select
        'replay'::text,
        v_claim.response_status,
        v_claim.response_body,
        true;
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
        false;
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
        false;
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
        false;
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
        false;
      return;
    elsif v_claim.outcome is distinct from 'claimed' then
      raise exception using
        errcode = '40001',
        message = 'unexpected idempotency claim outcome';
    end if;
  end if;

  select list.*
  into v_list
  from public.wine_lists list
  where list.id = p_wine_list_id
    and list.restaurant_id = p_restaurant_id
  for update;

  if not found then
    v_body := jsonb_build_object(
      'error',
      jsonb_build_object(
        'code', 'not_found',
        'message', 'Wine list not found.'
      )
    );
    if p_idempotency_key is not null then
      v_completed := public.complete_api_idempotency(
        p_restaurant_id,
        v_operation_id,
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
    select 'not_found'::text, 404, v_body, false;
    return;
  end if;

  if not p_publish then
    update public.wine_lists
    set is_published = false,
        slug = null
    where id = p_wine_list_id
      and restaurant_id = p_restaurant_id;

    v_body := jsonb_build_object('ok', true);
    if p_idempotency_key is not null then
      v_completed := public.complete_api_idempotency(
        p_restaurant_id,
        v_operation_id,
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
    select 'unpublished'::text, 200, v_body, false;
    return;
  end if;

  if p_has_slug then
    v_slug := p_slug;
  elsif v_list.slug is not null
        and char_length(v_list.slug) <= 50
        and v_list.slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
    v_slug := v_list.slug;
  else
    select restaurant.name
    into v_restaurant_name
    from public.restaurants restaurant
    where restaurant.id = p_restaurant_id;

    if v_restaurant_name is null then
      raise exception using
        errcode = '23503',
        message = 'wine-list restaurant was not found';
    end if;
    v_slug_source := pg_catalog.regexp_replace(
      pg_catalog.lower(pg_catalog.btrim(v_restaurant_name)),
      '[^a-z0-9]+',
      '-',
      'g'
    );
    v_slug_source := pg_catalog.regexp_replace(
      v_slug_source,
      '^-+|-+$',
      '',
      'g'
    );
    v_slug_source := pg_catalog.regexp_replace(
      pg_catalog.left(v_slug_source, 40),
      '-+$',
      '',
      'g'
    );
    if v_slug_source = '' then
      v_slug_source := 'wine-list';
    end if;
    v_generated_slug := true;
  end if;

  loop
    v_slug_attempt := v_slug_attempt + 1;
    if v_generated_slug then
      v_slug := public.generate_slug(v_slug_source);
      if char_length(v_slug) > 50
         or v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
        raise exception using
          errcode = '22023',
          message = 'generated publication slug was invalid';
      end if;
    end if;

    begin
      update public.wine_lists
      set is_published = true,
          last_published_at = clock_timestamp(),
          slug = v_slug
      where id = p_wine_list_id
        and restaurant_id = p_restaurant_id;
      exit;
    exception when unique_violation then
      if v_generated_slug then
        if v_slug_attempt < 16 then
          continue;
        end if;
        raise exception using
          errcode = '40001',
          message = 'could not allocate a unique publication slug';
      end if;

      v_body := jsonb_build_object(
        'error',
        jsonb_build_object(
          'code', 'slug_collision',
          'message', 'This slug is already in use.'
        )
      );
      if p_idempotency_key is not null then
        v_completed := public.complete_api_idempotency(
          p_restaurant_id,
          v_operation_id,
          p_idempotency_key,
          v_computed_hash,
          409,
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
      select 'slug_collision'::text, 409, v_body, false;
      return;
    end;
  end loop;

  v_body := jsonb_build_object('slug', v_slug);
  if p_idempotency_key is not null then
    v_completed := public.complete_api_idempotency(
      p_restaurant_id,
      v_operation_id,
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
  select 'published'::text, 200, v_body, false;
end;
$$;

revoke all on function public.clone_wine_list_idempotent(
  uuid,
  uuid,
  text,
  text
) from public;
revoke all on function public.clone_wine_list_idempotent(
  uuid,
  uuid,
  text,
  text
) from anon;
grant execute on function public.clone_wine_list_idempotent(
  uuid,
  uuid,
  text,
  text
) to authenticated;

revoke all on function public.set_wine_list_publication_idempotent(
  uuid,
  uuid,
  boolean,
  boolean,
  text,
  text,
  text
) from public;
revoke all on function public.set_wine_list_publication_idempotent(
  uuid,
  uuid,
  boolean,
  boolean,
  text,
  text,
  text
) from anon;
grant execute on function public.set_wine_list_publication_idempotent(
  uuid,
  uuid,
  boolean,
  boolean,
  text,
  text,
  text
) to authenticated;

comment on function public.clone_wine_list_idempotent(
  uuid,
  uuid,
  text,
  text
) is
  'Atomically clones an owned wine list and stores the exact keyed response.';
comment on function public.set_wine_list_publication_idempotent(
  uuid,
  uuid,
  boolean,
  boolean,
  text,
  text,
  text
) is
  'Atomically publishes or unpublishes a wine list with exact keyed replay.';
