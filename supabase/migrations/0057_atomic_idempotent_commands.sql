-- TER-020D03 — atomic high-risk command boundaries.
--
-- Opening a bottle previously decremented sealed inventory before attempting
-- a client-forbidden open_bottles write. Invitation acceptance attempted two
-- independently committed writes through RLS that excludes non-members. These
-- definer RPCs make each command one transaction and retain all caller,
-- tenant, and request-key checks inside that transaction.

do $$
begin
  if exists (
    select 1
    from public.invitations
    where invitations.role not in ('manager', 'staff')
  ) then
    raise exception using
      errcode = '23514',
      message =
        'atomic_invitation_preflight_failed: invitations contain a forbidden owner role';
  end if;
end;
$$;

alter table public.invitations
  add constraint invitations_invitable_role_check
  check (role in ('manager', 'staff'));

create or replace function public.open_bottle_from_inventory(
  p_restaurant_id uuid,
  p_wine_id uuid
) returns table (
  outcome text,
  bottle_id uuid,
  wine_id uuid,
  remaining_ml integer,
  opened_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_wine public.wines%rowtype;
  v_inventory public.inventory_items%rowtype;
  v_bottle public.open_bottles%rowtype;
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

  -- The wine lock serializes every manual-open command for this wine. It also
  -- makes each later inventory lookup observe the preceding command's commit.
  select *
  into v_wine
  from public.wines
  where wines.id = p_wine_id
    and wines.restaurant_id = p_restaurant_id
  for update;

  if not found then
    return query
    select
      'not_found'::text,
      null::uuid,
      null::uuid,
      null::integer,
      null::timestamptz;
    return;
  end if;

  -- Match record_pour's lock order (open bottle before inventory) so a
  -- simultaneous pour and manual-open cannot deadlock while taking the same
  -- two row locks.
  select *
  into v_bottle
  from public.open_bottles
  where open_bottles.wine_id = p_wine_id
    and open_bottles.restaurant_id = p_restaurant_id
  for update;

  select *
  into v_inventory
  from public.inventory_items
  where inventory_items.wine_id = p_wine_id
    and inventory_items.restaurant_id = p_restaurant_id
    and inventory_items.quantity > 0
  order by inventory_items.added_at, inventory_items.id
  limit 1
  for update;

  if not found then
    return query
    select
      'no_sealed_stock'::text,
      null::uuid,
      null::uuid,
      null::integer,
      null::timestamptz;
    return;
  end if;

  update public.inventory_items
  set quantity = quantity - 1
  where inventory_items.id = v_inventory.id
    and inventory_items.wine_id = p_wine_id
    and inventory_items.restaurant_id = p_restaurant_id
    and inventory_items.quantity > 0;

  if not found then
    raise exception using
      errcode = '40001',
      message = 'sealed inventory changed concurrently';
  end if;

  insert into public.open_bottles (
    wine_id,
    restaurant_id,
    remaining_ml,
    opened_at,
    opened_by,
    source_inventory_item_id,
    closed_at
  ) values (
    p_wine_id,
    p_restaurant_id,
    coalesce(v_wine.size_ml, 750),
    clock_timestamp(),
    v_user_id,
    v_inventory.id,
    null
  )
  on conflict on constraint open_bottles_wine_id_restaurant_id_key
  do update set
    remaining_ml = excluded.remaining_ml,
    opened_at = excluded.opened_at,
    opened_by = excluded.opened_by,
    source_inventory_item_id = excluded.source_inventory_item_id,
    closed_at = null
  returning * into v_bottle;

  return query
  select
    'opened'::text,
    v_bottle.id,
    v_bottle.wine_id,
    v_bottle.remaining_ml,
    v_bottle.opened_at;
end;
$$;

revoke all on function public.open_bottle_from_inventory(uuid, uuid)
  from public;
revoke all on function public.open_bottle_from_inventory(uuid, uuid)
  from anon;
grant execute on function public.open_bottle_from_inventory(uuid, uuid)
  to authenticated;

create or replace function public.accept_invitation_idempotent(
  p_token text,
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
  v_user_email text;
  v_invitation public.invitations%rowtype;
  v_idempotency public.api_idempotency%rowtype;
  v_existing_member boolean;
  v_body jsonb;
  v_now timestamptz;
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication required';
  end if;

  if p_token is null or btrim(p_token) = '' then
    raise exception using
      errcode = '22023',
      message = 'invitation token is required';
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

    -- Serialize dedicated accept calls for one user/key before reading the
    -- binding. A hash collision only serializes unrelated callers.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        v_user_id::text || ':' || p_idempotency_key,
        0
      )
    );

    select *
    into v_idempotency
    from public.api_idempotency
    where api_idempotency.user_id = v_user_id
      and api_idempotency.idempotency_key = p_idempotency_key
    for update;

    if found then
      if v_idempotency.operation_id
           <> 'api:POST:/api/team/accept-invite'
         or v_idempotency.request_hash <> p_request_hash then
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

      if v_idempotency.updated_at
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

      if v_idempotency.state = 'completed' then
        return query
        select
          'replay'::text,
          v_idempotency.response_status,
          v_idempotency.response_body,
          true;
        return;
      end if;

      if v_idempotency.state = 'failed_unknown' then
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
  end if;

  select lower(btrim(users.email))
  into v_user_email
  from auth.users
  where users.id = v_user_id;

  if v_user_email is null or v_user_email = '' then
    return query
    select
      'not_found'::text,
      404,
      jsonb_build_object(
        'error',
        jsonb_build_object(
          'code', 'not_found',
          'message', 'Invalid or expired invitation.'
        )
      ),
      false;
    return;
  end if;

  select *
  into v_invitation
  from public.invitations
  where invitations.token = p_token
    and lower(btrim(invitations.email)) = v_user_email
  for update;

  if not found then
    return query
    select
      'not_found'::text,
      404,
      jsonb_build_object(
        'error',
        jsonb_build_object(
          'code', 'not_found',
          'message', 'Invalid or expired invitation.'
        )
      ),
      false;
    return;
  end if;

  if v_invitation.role not in ('manager', 'staff') then
    return query
    select
      'not_found'::text,
      404,
      jsonb_build_object(
        'error',
        jsonb_build_object(
          'code', 'not_found',
          'message', 'Invalid or expired invitation.'
        )
      ),
      false;
    return;
  end if;

  if p_idempotency_key is not null then
    insert into public.api_idempotency (
      restaurant_id,
      user_id,
      operation_id,
      idempotency_key,
      request_hash
    ) values (
      v_invitation.restaurant_id,
      v_user_id,
      'api:POST:/api/team/accept-invite',
      p_idempotency_key,
      p_request_hash
    )
    on conflict (user_id, idempotency_key) do nothing;

    if not found then
      -- A generic claim can race the advisory-locked dedicated function. The
      -- unique key is authoritative, so classify that committed winner.
      select *
      into v_idempotency
      from public.api_idempotency
      where api_idempotency.user_id = v_user_id
        and api_idempotency.idempotency_key = p_idempotency_key
      for update;

      if v_idempotency.restaurant_id <> v_invitation.restaurant_id
         or v_idempotency.operation_id
              <> 'api:POST:/api/team/accept-invite'
         or v_idempotency.request_hash <> p_request_hash then
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

      if v_idempotency.updated_at
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

      if v_idempotency.state = 'completed' then
        return query
        select
          'replay'::text,
          v_idempotency.response_status,
          v_idempotency.response_body,
          true;
        return;
      end if;

      if v_idempotency.state = 'failed_unknown' then
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
  end if;

  if v_invitation.accepted_at is not null then
    v_body := jsonb_build_object(
      'error',
      jsonb_build_object(
        'code', 'bad_request',
        'message', 'This invitation has already been used.'
      )
    );
    if p_idempotency_key is not null then
      update public.api_idempotency
      set state = 'completed',
          response_status = 400,
          response_headers = '{}'::jsonb,
          response_body = v_body,
          updated_at = clock_timestamp(),
          completed_at = clock_timestamp()
      where api_idempotency.user_id = v_user_id
        and api_idempotency.idempotency_key = p_idempotency_key
        and api_idempotency.state = 'in_progress';
    end if;
    return query select 'already_used'::text, 400, v_body, false;
    return;
  end if;

  if v_invitation.expires_at < clock_timestamp() then
    v_body := jsonb_build_object(
      'error',
      jsonb_build_object(
        'code', 'bad_request',
        'message', 'This invitation has expired.'
      )
    );
    if p_idempotency_key is not null then
      update public.api_idempotency
      set state = 'completed',
          response_status = 400,
          response_headers = '{}'::jsonb,
          response_body = v_body,
          updated_at = clock_timestamp(),
          completed_at = clock_timestamp()
      where api_idempotency.user_id = v_user_id
        and api_idempotency.idempotency_key = p_idempotency_key
        and api_idempotency.state = 'in_progress';
    end if;
    return query select 'invitation_expired'::text, 400, v_body, false;
    return;
  end if;

  select exists (
    select 1
    from public.memberships
    where memberships.user_id = v_user_id
      and memberships.restaurant_id = v_invitation.restaurant_id
  )
  into v_existing_member;

  insert into public.memberships (
    user_id,
    restaurant_id,
    role
  ) values (
    v_user_id,
    v_invitation.restaurant_id,
    v_invitation.role
  )
  on conflict (user_id, restaurant_id) do nothing;

  v_now := clock_timestamp();
  update public.invitations
  set accepted_at = v_now
  where invitations.id = v_invitation.id
    and invitations.accepted_at is null;

  if not found then
    raise exception using
      errcode = '40001',
      message = 'invitation acceptance changed concurrently';
  end if;

  v_body := jsonb_build_object(
    'success', true,
    case when v_existing_member then 'message' else 'role' end,
    case
      when v_existing_member
        then 'You are already a member of this restaurant.'
      else v_invitation.role::text
    end,
    'restaurantId', v_invitation.restaurant_id
  );

  if p_idempotency_key is not null then
    update public.api_idempotency
    set state = 'completed',
        response_status = 200,
        response_headers = '{}'::jsonb,
        response_body = v_body,
        updated_at = v_now,
        completed_at = v_now
    where api_idempotency.user_id = v_user_id
      and api_idempotency.idempotency_key = p_idempotency_key
      and api_idempotency.restaurant_id = v_invitation.restaurant_id
      and api_idempotency.operation_id
            = 'api:POST:/api/team/accept-invite'
      and api_idempotency.request_hash = p_request_hash
      and api_idempotency.state = 'in_progress';

    if not found then
      raise exception using
        errcode = '40001',
        message = 'idempotency completion changed concurrently';
    end if;
  end if;

  return query select 'accepted'::text, 200, v_body, false;
end;
$$;

revoke all on function public.accept_invitation_idempotent(text, text, text)
  from public;
revoke all on function public.accept_invitation_idempotent(text, text, text)
  from anon;
grant execute on function public.accept_invitation_idempotent(text, text, text)
  to authenticated;

comment on function public.open_bottle_from_inventory(uuid, uuid) is
  'Atomically decrements one sealed unit and opens or replaces the caller-tenant bottle.';

comment on function public.accept_invitation_idempotent(text, text, text) is
  'Atomically validates and accepts an email-bound invitation with optional exact-response idempotency.';
