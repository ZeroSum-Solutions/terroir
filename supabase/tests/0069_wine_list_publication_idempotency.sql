-- Focused acceptance for 0069_wine_list_publication_idempotency.sql.
-- Run only against an isolated PostgreSQL 17 database with migrations through
-- 0069 and a password-authenticated dblink_conn.

\if :{?dblink_conn}
\else
\echo '0069 acceptance requires -v dblink_conn=<database URL>'
\quit 2
\endif

create extension if not exists dblink with schema extensions;

begin;

create or replace function pg_temp.command_hash(p_identity text)
returns text
language sql
immutable
as $$
  select pg_catalog.encode(
    extensions.digest(
      pg_catalog.int8send(
        pg_catalog.octet_length(
          pg_catalog.convert_to(p_identity, 'UTF8')
        )::bigint
      ) || pg_catalog.convert_to(p_identity, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
$$;

create or replace function pg_temp.expect_failure(
  p_sql text,
  p_sqlstate text
) returns void
language plpgsql
as $$
declare
  v_sqlstate text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_sqlstate = returned_sqlstate;
    if v_sqlstate <> p_sqlstate then
      raise exception
        'expected SQLSTATE %, received % for %',
        p_sqlstate,
        v_sqlstate,
        p_sql;
    end if;
    return;
  end;
  raise exception 'expected statement to fail: %', p_sql;
end;
$$;

insert into auth.users (
  id,
  email,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
) values
  (
    '66000000-0000-4000-8000-000000000001',
    'manager-0069@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '66000000-0000-4000-8000-000000000002',
    'staff-0069@example.test',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

insert into public.restaurants (id, name) values
  (
    '66100000-0000-4000-8000-000000000001',
    'D22 Publication Restaurant'
  ),
  (
    '66100000-0000-4000-8000-000000000002',
    'D22 Other Restaurant'
  );

insert into public.memberships (user_id, restaurant_id, role) values
  (
    '66000000-0000-4000-8000-000000000001',
    '66100000-0000-4000-8000-000000000001',
    'manager'
  ),
  (
    '66000000-0000-4000-8000-000000000002',
    '66100000-0000-4000-8000-000000000001',
    'staff'
  );

insert into public.wines (
  id,
  restaurant_id,
  name,
  producer
) values (
  '66200000-0000-4000-8000-000000000001',
  '66100000-0000-4000-8000-000000000001',
  'D22 Barolo',
  'D22 Producer'
);

insert into public.wine_lists (
  id,
  restaurant_id,
  name,
  description,
  template,
  archived
) values
  (
    '66300000-0000-4000-8000-000000000001',
    '66100000-0000-4000-8000-000000000001',
    'D22 Dinner',
    'Display description',
    'modern',
    true
  ),
  (
    '66300000-0000-4000-8000-000000000002',
    '66100000-0000-4000-8000-000000000001',
    'D22 Generated',
    null,
    'classic',
    false
  ),
  (
    '66300000-0000-4000-8000-000000000003',
    '66100000-0000-4000-8000-000000000001',
    'D22 Collision Owner',
    null,
    'classic',
    false
  ),
  (
    '66300000-0000-4000-8000-000000000004',
    '66100000-0000-4000-8000-000000000001',
    'D22 Long Name',
    null,
    'classic',
    false
  ),
  (
    '66300000-0000-4000-8000-000000000099',
    '66100000-0000-4000-8000-000000000002',
    'D22 Foreign',
    null,
    'classic',
    false
  );

insert into public.wine_list_sections (
  id,
  wine_list_id,
  name,
  position
) values (
  '66400000-0000-4000-8000-000000000001',
  '66300000-0000-4000-8000-000000000001',
  'Reserve Reds',
  7
);

insert into public.wine_list_items (
  id,
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
) values (
  '66500000-0000-4000-8000-000000000001',
  '66400000-0000-4000-8000-000000000001',
  '66200000-0000-4000-8000-000000000001',
  125,
  28,
  150,
  'fixed',
  4,
  false,
  'Rose and tar',
  'Library Barolo',
  'Old vines',
  true
);

update public.wine_lists
set slug = 'd22-collision'
where id = '66300000-0000-4000-8000-000000000003';

do $$
begin
  if has_function_privilege(
    'anon',
    'public.clone_wine_list_idempotent(uuid,uuid,text,text)',
    'EXECUTE'
  ) or has_function_privilege(
    'anon',
    'public.set_wine_list_publication_idempotent(uuid,uuid,boolean,boolean,text,text,text)',
    'EXECUTE'
  ) then
    raise exception 'anon retains D22 function execution';
  end if;
  if not has_function_privilege(
    'authenticated',
    'public.clone_wine_list_idempotent(uuid,uuid,text,text)',
    'EXECUTE'
  ) or not has_function_privilege(
    'authenticated',
    'public.set_wine_list_publication_idempotent(uuid,uuid,boolean,boolean,text,text,text)',
    'EXECUTE'
  ) then
    raise exception 'authenticated lacks D22 function execution';
  end if;
  if exists (
    select 1
    from pg_proc
    where oid in (
      to_regprocedure(
        'public.clone_wine_list_idempotent(uuid,uuid,text,text)'
      ),
      to_regprocedure(
        'public.set_wine_list_publication_idempotent(uuid,uuid,boolean,boolean,text,text,text)'
      )
    )
      and (
        not prosecdef
        or not (
          coalesce(proconfig, '{}'::text[])
          @> array['search_path=""']::text[]
        )
      )
  ) then
    raise exception 'D22 function execution context is not hardened';
  end if;
end;
$$;

-- Staff cannot reach the manager-only transaction boundary.
select set_config(
  'request.jwt.claim.sub',
  '66000000-0000-4000-8000-000000000002',
  true
);
set local role authenticated;
select pg_temp.expect_failure(
  $sql$
    select * from public.clone_wine_list_idempotent(
      '66100000-0000-4000-8000-000000000001',
      '66300000-0000-4000-8000-000000000001'
    )
  $sql$,
  '42501'
);
reset role;

select set_config(
  'request.jwt.claim.sub',
  '66000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;

-- The clone preserves every display field, returns one allocated ID, and
-- replays that ID without adding a second clone.
do $$
declare
  v_hash text := pg_temp.command_hash(
    '{"id":"66300000-0000-4000-8000-000000000001"}'
  );
  v_fresh record;
  v_replay record;
  v_clone_id uuid;
begin
  select * into strict v_fresh
  from public.clone_wine_list_idempotent(
    '66100000-0000-4000-8000-000000000001',
    '66300000-0000-4000-8000-000000000001',
    'clone_replay_key_0069',
    v_hash
  );
  select * into strict v_replay
  from public.clone_wine_list_idempotent(
    '66100000-0000-4000-8000-000000000001',
    '66300000-0000-4000-8000-000000000001',
    'clone_replay_key_0069',
    v_hash
  );
  v_clone_id := (v_fresh.response_body ->> 'id')::uuid;

  if v_fresh.outcome <> 'cloned'
     or v_fresh.response_status <> 200
     or v_fresh.replayed
     or v_replay.outcome <> 'replay'
     or not v_replay.replayed
     or v_replay.response_body <> v_fresh.response_body then
    raise exception 'clone replay mismatch: fresh=%, replay=%',
      row_to_json(v_fresh),
      row_to_json(v_replay);
  end if;

  if not exists (
    select 1
    from public.wine_lists clone
    where clone.id = v_clone_id
      and clone.restaurant_id =
        '66100000-0000-4000-8000-000000000001'
      and clone.name = 'D22 Dinner (copy)'
      and clone.description = 'Display description'
      and clone.template = 'modern'
      and not clone.is_published
      and not clone.archived
      and clone.slug is null
  ) then
    raise exception 'clone list fields were not preserved';
  end if;

  if not exists (
    select 1
    from public.wine_list_sections section
    join public.wine_list_items item
      on item.section_id = section.id
    where section.wine_list_id = v_clone_id
      and section.name = 'Reserve Reds'
      and section.position = 7
      and item.wine_id =
        '66200000-0000-4000-8000-000000000001'
      and item.bottle_price = 125
      and item.glass_price = 28
      and item.glass_pour_ml = 150
      and item.pour_size_mode = 'fixed'
      and item.position = 4
      and not item.is_available
      and item.tasting_note = 'Rose and tar'
      and item.name_override = 'Library Barolo'
      and item.blurb = 'Old vines'
      and item.hidden
  ) then
    raise exception 'clone section/item fields were not preserved';
  end if;
end;
$$;

do $$
begin
  if (
    select count(*)
    from public.wine_lists
    where restaurant_id =
      '66100000-0000-4000-8000-000000000001'
      and name = 'D22 Dinner (copy)'
  ) <> 1 then
    raise exception 'clone replay duplicated the allocated list';
  end if;
end;
$$;

-- SQL reconstructs the normalized UUID identity; a caller-supplied hash for
-- any other representation is rejected before mutation.
select pg_temp.expect_failure(
  format(
    $sql$
      select * from public.clone_wine_list_idempotent(
        '66100000-0000-4000-8000-000000000001',
        '66300000-0000-4000-8000-000000000002',
        'clone_wrong_hash_0069',
        %L
      )
    $sql$,
    repeat('f', 64)
  ),
  '22023'
);

-- A name whose 40-character truncation lands on a separator must still
-- generate a valid slug with the real generator.
reset role;
update public.restaurants
set name = 'Antica Osteria del Ponte Ristorante Bar Vino'
where id = '66100000-0000-4000-8000-000000000001';
set local role authenticated;
do $$
declare
  v_result record;
begin
  select * into strict v_result
  from public.set_wine_list_publication_idempotent(
    '66100000-0000-4000-8000-000000000001',
    '66300000-0000-4000-8000-000000000004',
    true,
    false,
    null,
    null,
    null
  );
  if v_result.outcome <> 'published'
     or v_result.response_body ->> 'slug'
       !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
     or char_length(v_result.response_body ->> 'slug') > 50 then
    raise exception 'long-name generated slug was invalid: %',
      row_to_json(v_result);
  end if;
end;
$$;

-- Make the first generated candidate collide, then return a safe candidate.
-- The non-ASCII restaurant name must be replaced with the safe fallback base.
reset role;
update public.restaurants
set name = '寿司!!!'
where id = '66100000-0000-4000-8000-000000000001';
create temp table generated_slug_sequence_0069 (
  call_count integer not null,
  last_input text
);
insert into generated_slug_sequence_0069 values (0, null);
grant select on pg_temp.generated_slug_sequence_0069 to authenticated;
create or replace function public.generate_slug(input text)
returns text
language plpgsql
as $$
declare
  v_call_count integer;
begin
  update pg_temp.generated_slug_sequence_0069
  set call_count = call_count + 1,
      last_input = input
  returning call_count into v_call_count;
  if v_call_count = 1 then
    return 'd22-collision';
  end if;
  return 'wine-list-safe';
end;
$$;
set local role authenticated;

-- Custom publish, slug collision, generated slug, and unpublish all store and
-- replay their exact status/body with operation-specific identities.
do $$
declare
  v_custom_hash text := pg_temp.command_hash(
    '{"body":{"slug":"d22-public"},"id":"66300000-0000-4000-8000-000000000001"}'
  );
  v_collision_hash text := pg_temp.command_hash(
    '{"body":{"slug":"d22-collision"},"id":"66300000-0000-4000-8000-000000000002"}'
  );
  v_generated_hash text := pg_temp.command_hash(
    '{"body":{},"id":"66300000-0000-4000-8000-000000000002"}'
  );
  v_unpublish_hash text := pg_temp.command_hash(
    '{"id":"66300000-0000-4000-8000-000000000001"}'
  );
  v_fresh record;
  v_replay record;
begin
  select * into strict v_fresh
  from public.set_wine_list_publication_idempotent(
    '66100000-0000-4000-8000-000000000001',
    '66300000-0000-4000-8000-000000000001',
    true,
    true,
    'd22-public',
    'publish_custom_key_0069',
    v_custom_hash
  );
  select * into strict v_replay
  from public.set_wine_list_publication_idempotent(
    '66100000-0000-4000-8000-000000000001',
    '66300000-0000-4000-8000-000000000001',
    true,
    true,
    'd22-public',
    'publish_custom_key_0069',
    v_custom_hash
  );
  if v_fresh.outcome <> 'published'
     or v_fresh.response_body <> '{"slug":"d22-public"}'::jsonb
     or v_replay.outcome <> 'replay'
     or v_replay.response_body <> v_fresh.response_body then
    raise exception 'custom publish mismatch: fresh=%, replay=%',
      row_to_json(v_fresh),
      row_to_json(v_replay);
  end if;

  select * into strict v_fresh
  from public.set_wine_list_publication_idempotent(
    '66100000-0000-4000-8000-000000000001',
    '66300000-0000-4000-8000-000000000002',
    true,
    true,
    'd22-collision',
    'publish_collision_key_0069',
    v_collision_hash
  );
  select * into strict v_replay
  from public.set_wine_list_publication_idempotent(
    '66100000-0000-4000-8000-000000000001',
    '66300000-0000-4000-8000-000000000002',
    true,
    true,
    'd22-collision',
    'publish_collision_key_0069',
    v_collision_hash
  );
  if v_fresh.outcome <> 'slug_collision'
     or v_fresh.response_status <> 409
     or v_fresh.response_body #>> '{error,code}' <> 'slug_collision'
     or v_replay.outcome <> 'replay'
     or v_replay.response_body <> v_fresh.response_body then
    raise exception 'collision publish mismatch: fresh=%, replay=%',
      row_to_json(v_fresh),
      row_to_json(v_replay);
  end if;

  select * into strict v_fresh
  from public.set_wine_list_publication_idempotent(
    '66100000-0000-4000-8000-000000000001',
    '66300000-0000-4000-8000-000000000002',
    true,
    false,
    null,
    'publish_generated_key_0069',
    v_generated_hash
  );
  select * into strict v_replay
  from public.set_wine_list_publication_idempotent(
    '66100000-0000-4000-8000-000000000001',
    '66300000-0000-4000-8000-000000000002',
    true,
    false,
    null,
    'publish_generated_key_0069',
    v_generated_hash
  );
  if v_fresh.outcome <> 'published'
     or v_fresh.response_body ->> 'slug' <> 'wine-list-safe'
     or v_replay.outcome <> 'replay'
     or v_replay.response_body <> v_fresh.response_body then
    raise exception 'generated publish mismatch: fresh=%, replay=%',
      row_to_json(v_fresh),
      row_to_json(v_replay);
  end if;
  if (
    select call_count <> 2 or last_input <> 'wine-list'
    from pg_temp.generated_slug_sequence_0069
  ) then
    raise exception 'generated slug did not retry with the safe base';
  end if;

  select * into strict v_fresh
  from public.set_wine_list_publication_idempotent(
    '66100000-0000-4000-8000-000000000001',
    '66300000-0000-4000-8000-000000000001',
    false,
    false,
    null,
    'unpublish_replay_key_0069',
    v_unpublish_hash
  );
  select * into strict v_replay
  from public.set_wine_list_publication_idempotent(
    '66100000-0000-4000-8000-000000000001',
    '66300000-0000-4000-8000-000000000001',
    false,
    false,
    null,
    'unpublish_replay_key_0069',
    v_unpublish_hash
  );
  if v_fresh.outcome <> 'unpublished'
     or v_fresh.response_body <> '{"ok":true}'::jsonb
     or v_replay.outcome <> 'replay'
     or v_replay.response_body <> v_fresh.response_body
     or exists (
       select 1
       from public.wine_lists
       where id = '66300000-0000-4000-8000-000000000001'
         and (is_published or slug is not null)
     ) then
    raise exception 'unpublish mismatch: fresh=%, replay=%',
      row_to_json(v_fresh),
      row_to_json(v_replay);
  end if;
end;
$$;

-- Exhausting all generated candidates must abort both the mutation and the
-- idempotency claim so the same persistent key can be retried later.
reset role;
update public.wine_lists
set is_published = false,
    slug = null
where id = '66300000-0000-4000-8000-000000000002';
create temp sequence generated_slug_exhaustion_0069;
create or replace function public.generate_slug(input text)
returns text
language plpgsql
as $$
begin
  perform pg_catalog.nextval(
    'pg_temp.generated_slug_exhaustion_0069'::regclass
  );
  return 'd22-collision';
end;
$$;
set local role authenticated;

select pg_temp.expect_failure(
  format(
    $sql$
      select * from public.set_wine_list_publication_idempotent(
        '66100000-0000-4000-8000-000000000001',
        '66300000-0000-4000-8000-000000000002',
        true,
        false,
        null,
        'publish_exhausted_key_0069',
        %L
      )
    $sql$,
    pg_temp.command_hash(
      '{"body":{},"id":"66300000-0000-4000-8000-000000000002"}'
    )
  ),
  '40001'
);

reset role;
do $$
begin
  if (
    select last_value <> 16
    from pg_temp.generated_slug_exhaustion_0069
  ) or exists (
    select 1
    from public.api_idempotency
    where idempotency_key = 'publish_exhausted_key_0069'
  ) or exists (
    select 1
    from public.wine_lists
    where id = '66300000-0000-4000-8000-000000000002'
      and (is_published or slug is not null)
  ) then
    raise exception 'generated slug exhaustion leaked claim or list state';
  end if;
end;
$$;

-- A completion failure rolls the clone and its claim back together.
create or replace function pg_temp.reject_clone_completion_0069()
returns trigger
language plpgsql
as $$
begin
  raise exception using
    errcode = 'XX000',
    message = 'induced D22 clone completion failure';
end;
$$;

create trigger reject_clone_completion_0069
before update on public.api_idempotency
for each row
when (new.idempotency_key = 'clone_rollback_key_0069')
execute function pg_temp.reject_clone_completion_0069();

select pg_temp.expect_failure(
  format(
    $sql$
      select * from public.clone_wine_list_idempotent(
        '66100000-0000-4000-8000-000000000001',
        '66300000-0000-4000-8000-000000000002',
        'clone_rollback_key_0069',
        %L
      )
    $sql$,
    pg_temp.command_hash(
      '{"id":"66300000-0000-4000-8000-000000000002"}'
    )
  ),
  'XX000'
);

do $$
begin
  if exists (
    select 1
    from public.wine_lists
    where name = 'D22 Generated (copy)'
  ) or exists (
    select 1
    from public.api_idempotency
    where idempotency_key = 'clone_rollback_key_0069'
  ) then
    raise exception 'completion failure leaked clone state';
  end if;
end;
$$;

reset role;
rollback;

-- Commit a minimal fixture for two independent connections. A completion
-- trigger holds the first transaction long enough for the second request to
-- overlap on the same key; one result must be fresh, one replay, and only one
-- allocated clone may exist.
create or replace function pg_temp.command_hash(p_identity text)
returns text
language sql
immutable
as $$
  select pg_catalog.encode(
    extensions.digest(
      pg_catalog.int8send(
        pg_catalog.octet_length(
          pg_catalog.convert_to(p_identity, 'UTF8')
        )::bigint
      ) || pg_catalog.convert_to(p_identity, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
$$;

insert into auth.users (
  id,
  email,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
) values (
  '66000000-0000-4000-8000-000000000010',
  'concurrent-manager-0069@example.test',
  '{}'::jsonb,
  '{"restaurant_name":"D22 Concurrent Auto Restaurant"}'::jsonb,
  now(),
  now()
);
insert into public.restaurants (id, name) values (
  '66100000-0000-4000-8000-000000000010',
  'D22 Concurrent Restaurant'
);
insert into public.memberships (user_id, restaurant_id, role) values (
  '66000000-0000-4000-8000-000000000010',
  '66100000-0000-4000-8000-000000000010',
  'manager'
);
insert into public.wine_lists (
  id,
  restaurant_id,
  name
) values (
  '66300000-0000-4000-8000-000000000010',
  '66100000-0000-4000-8000-000000000010',
  'D22 Concurrent Source'
);

create or replace function public.delay_clone_completion_0069()
returns trigger
language plpgsql
as $$
begin
  perform pg_sleep(1);
  return new;
end;
$$;
create trigger delay_clone_completion_0069
before update on public.api_idempotency
for each row
when (new.idempotency_key = 'clone_concurrent_key_0069')
execute function public.delay_clone_completion_0069();

select extensions.dblink_connect('d22_clone_a', :'dblink_conn');
select extensions.dblink_connect('d22_clone_b', :'dblink_conn');
select extensions.dblink_exec(
  'd22_clone_a',
  'set request.jwt.claim.sub = ''66000000-0000-4000-8000-000000000010''; set role authenticated'
);
select extensions.dblink_exec(
  'd22_clone_b',
  'set request.jwt.claim.sub = ''66000000-0000-4000-8000-000000000010''; set role authenticated'
);

select extensions.dblink_send_query(
  'd22_clone_a',
  format(
    $sql$
      select * from public.clone_wine_list_idempotent(
        '66100000-0000-4000-8000-000000000010',
        '66300000-0000-4000-8000-000000000010',
        'clone_concurrent_key_0069',
        %L
      )
    $sql$,
    pg_temp.command_hash(
      '{"id":"66300000-0000-4000-8000-000000000010"}'
    )
  )
);
select extensions.dblink_send_query(
  'd22_clone_b',
  format(
    $sql$
      select * from public.clone_wine_list_idempotent(
        '66100000-0000-4000-8000-000000000010',
        '66300000-0000-4000-8000-000000000010',
        'clone_concurrent_key_0069',
        %L
      )
    $sql$,
    pg_temp.command_hash(
      '{"id":"66300000-0000-4000-8000-000000000010"}'
    )
  )
);

create temp table d22_concurrent_results (
  lane text,
  outcome text,
  response_status integer,
  response_body jsonb,
  replayed boolean
);
insert into d22_concurrent_results
select 'a', result.*
from extensions.dblink_get_result('d22_clone_a') as result(
  outcome text,
  response_status integer,
  response_body jsonb,
  replayed boolean
);
insert into d22_concurrent_results
select 'b', result.*
from extensions.dblink_get_result('d22_clone_b') as result(
  outcome text,
  response_status integer,
  response_body jsonb,
  replayed boolean
);

do $$
begin
  if (
    select array_agg(outcome order by outcome)
    from d22_concurrent_results
  ) <> array['cloned', 'replay'] then
    raise exception 'concurrent outcomes were %',
      (select jsonb_agg(to_jsonb(result)) from d22_concurrent_results result);
  end if;
  if (
    select count(distinct response_body ->> 'id')
    from d22_concurrent_results
  ) <> 1 then
    raise exception 'concurrent responses did not share one clone ID';
  end if;
  if (
    select count(*)
    from public.wine_lists
    where restaurant_id =
      '66100000-0000-4000-8000-000000000010'
      and name = 'D22 Concurrent Source (copy)'
  ) <> 1 then
    raise exception 'concurrent requests allocated multiple clones';
  end if;
end;
$$;

select extensions.dblink_disconnect('d22_clone_a');
select extensions.dblink_disconnect('d22_clone_b');
drop trigger delay_clone_completion_0069 on public.api_idempotency;
drop function public.delay_clone_completion_0069();
drop table d22_concurrent_results;

delete from public.restaurants
where id = '66100000-0000-4000-8000-000000000010'
   or name = 'D22 Concurrent Auto Restaurant';
delete from auth.users
where id = '66000000-0000-4000-8000-000000000010';

select '0069 wine-list publication idempotency acceptance passed' as result;
