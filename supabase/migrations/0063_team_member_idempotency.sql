-- TER-020D13 — make team member role changes and removals atomic with their
-- caller-scoped idempotency records. Both commands serialize the restaurant's
-- membership set so concurrent owner changes cannot violate its invariants.

create extension if not exists pgcrypto with schema extensions;

create or replace function public.update_team_member_role_idempotent(
  p_restaurant_id uuid,
  p_member_id uuid,
  p_role public.membership_role,
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
  v_target public.memberships%rowtype;
  v_identity text;
  v_request_hash text;
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

  if p_restaurant_id is null
     or p_member_id is null
     or p_role is null then
    raise exception using
      errcode = '22023',
      message = 'restaurant_id, member_id, and role are required';
  end if;

  if not public.is_member_with_role(p_restaurant_id, 'owner') then
    raise exception using
      errcode = '42501',
      message = 'forbidden';
  end if;

  -- createIdempotencyRequestHash({ id, role }) sorts these two keys and frames
  -- the UTF-8 canonical JSON with an eight-byte big-endian length.
  v_identity :=
    '{"id":' || pg_catalog.to_json(p_member_id::text)::text ||
    ',"role":' || pg_catalog.to_json(p_role::text)::text ||
    '}';
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
        message = 'request hash does not match the canonical role identity';
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
                <> 'api:PATCH:/api/team/members/{param}'
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
        'api:PATCH:/api/team/members/{param}',
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

  -- Lock every membership in a stable order, then re-check the actor's owner
  -- role under that lock. Different keys and different owners therefore still
  -- share one serial membership-invariant boundary.
  perform 1
  from public.memberships
  where restaurant_id = p_restaurant_id
  order by id
  for update;

  if not exists (
    select 1
    from public.memberships
    where restaurant_id = p_restaurant_id
      and user_id = v_user_id
      and role = 'owner'
  ) then
    raise exception using
      errcode = '42501',
      message = 'forbidden';
  end if;

  select *
  into v_target
  from public.memberships
  where id = p_member_id
    and restaurant_id = p_restaurant_id;

  if not found then
    v_outcome := 'not_found';
    v_status := 404;
    v_body := jsonb_build_object(
      'error',
      jsonb_build_object(
        'code', 'not_found',
        'message', 'Member not found.'
      )
    );
  elsif v_target.role = 'owner'
        and p_role <> 'owner'
        and (
          select count(*)
          from public.memberships
          where restaurant_id = p_restaurant_id
            and role = 'owner'
        ) <= 1 then
    v_outcome := 'last_owner';
    v_status := 400;
    v_body := jsonb_build_object(
      'error',
      jsonb_build_object(
        'code', 'bad_request',
        'message', 'Cannot demote the last owner.'
      )
    );
  else
    update public.memberships
    set role = p_role
    where id = p_member_id
      and restaurant_id = p_restaurant_id;

    if not found then
      raise exception using
        errcode = '40001',
        message = 'member role target changed concurrently';
    end if;

    v_outcome := 'updated';
    v_status := 200;
    v_body := jsonb_build_object('success', true);
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
            = 'api:PATCH:/api/team/members/{param}'
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

revoke all on function public.update_team_member_role_idempotent(
  uuid,
  uuid,
  public.membership_role,
  text,
  text
) from public;
revoke all on function public.update_team_member_role_idempotent(
  uuid,
  uuid,
  public.membership_role,
  text,
  text
) from anon;
grant execute on function public.update_team_member_role_idempotent(
  uuid,
  uuid,
  public.membership_role,
  text,
  text
) to authenticated;

comment on function public.update_team_member_role_idempotent(
  uuid,
  uuid,
  public.membership_role,
  text,
  text
) is
  'Atomically changes one team member role and stores or replays its exact keyed API response.';

create or replace function public.remove_team_member_idempotent(
  p_restaurant_id uuid,
  p_member_id uuid,
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
  v_target public.memberships%rowtype;
  v_identity text;
  v_request_hash text;
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

  if p_restaurant_id is null or p_member_id is null then
    raise exception using
      errcode = '22023',
      message = 'restaurant_id and member_id are required';
  end if;

  if not public.is_member_with_role(p_restaurant_id, 'owner') then
    raise exception using
      errcode = '42501',
      message = 'forbidden';
  end if;

  v_identity :=
    '{"id":' || pg_catalog.to_json(p_member_id::text)::text ||
    '}';
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
        message = 'request hash does not match the canonical removal identity';
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
                <> 'api:DELETE:/api/team/members/{param}'
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
        'api:DELETE:/api/team/members/{param}',
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

  perform 1
  from public.memberships
  where restaurant_id = p_restaurant_id
  order by id
  for update;

  if not exists (
    select 1
    from public.memberships
    where restaurant_id = p_restaurant_id
      and user_id = v_user_id
      and role = 'owner'
  ) then
    raise exception using
      errcode = '42501',
      message = 'forbidden';
  end if;

  select *
  into v_target
  from public.memberships
  where id = p_member_id
    and restaurant_id = p_restaurant_id;

  if not found then
    v_outcome := 'not_found';
    v_status := 404;
    v_body := jsonb_build_object(
      'error',
      jsonb_build_object(
        'code', 'not_found',
        'message', 'Member not found.'
      )
    );
  elsif v_target.user_id = v_user_id then
    v_outcome := 'self_removal';
    v_status := 400;
    v_body := jsonb_build_object(
      'error',
      jsonb_build_object(
        'code', 'bad_request',
        'message', 'Cannot remove yourself.'
      )
    );
  else
    delete from public.memberships
    where id = p_member_id
      and restaurant_id = p_restaurant_id;

    if not found then
      raise exception using
        errcode = '40001',
        message = 'member removal target changed concurrently';
    end if;

    -- The actor was revalidated as an owner while the complete membership set
    -- was locked, and self-removal is forbidden. At least that owner remains.
    v_outcome := 'removed';
    v_status := 200;
    v_body := jsonb_build_object('success', true);
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
            = 'api:DELETE:/api/team/members/{param}'
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

revoke all on function public.remove_team_member_idempotent(
  uuid,
  uuid,
  text,
  text
) from public;
revoke all on function public.remove_team_member_idempotent(
  uuid,
  uuid,
  text,
  text
) from anon;
grant execute on function public.remove_team_member_idempotent(
  uuid,
  uuid,
  text,
  text
) to authenticated;

comment on function public.remove_team_member_idempotent(
  uuid,
  uuid,
  text,
  text
) is
  'Atomically removes one team member and stores or replays its exact keyed API response.';
