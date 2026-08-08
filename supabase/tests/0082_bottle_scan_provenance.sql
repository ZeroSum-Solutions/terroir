-- Focused acceptance for 0082_bottle_scan_inventory_provenance.sql.
-- Run only against an isolated database with migrations through 0082:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f supabase/tests/0082_bottle_scan_provenance.sql

begin;

insert into auth.users (
  id,
  email,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
) values (
  '82000000-0000-4000-8000-000000000001',
  'staff-0082@example.test',
  '{}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
);

insert into public.restaurants (id, name) values (
  '82100000-0000-4000-8000-000000000001',
  'Bottle Scan Provenance'
);

insert into public.memberships (
  user_id,
  restaurant_id,
  role
) values (
  '82000000-0000-4000-8000-000000000001',
  '82100000-0000-4000-8000-000000000001',
  'staff'
);

insert into public.wines (
  id,
  restaurant_id,
  name,
  producer,
  size_ml
) values (
  '82200000-0000-4000-8000-000000000001',
  '82100000-0000-4000-8000-000000000001',
  'Scanned Provenance',
  '0082 Producer',
  750
);

select set_config(
  'request.jwt.claim.sub',
  '82000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;

do $$
declare
  v_fresh record;
  v_replay record;
  v_identity text :=
    '{"bin_location":"R-82","section":"Reserve",'
      || '"wine_id":"82200000-0000-4000-8000-000000000001"}';
  v_hash text;
begin
  v_hash := pg_catalog.encode(
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

  select * into strict v_fresh
  from public.confirm_bottle_scan_idempotent(
    '82100000-0000-4000-8000-000000000001',
    '82200000-0000-4000-8000-000000000001',
    'Reserve',
    'R-82',
    'provenance_key_0082',
    v_hash
  );
  select * into strict v_replay
  from public.confirm_bottle_scan_idempotent(
    '82100000-0000-4000-8000-000000000001',
    '82200000-0000-4000-8000-000000000001',
    'Reserve',
    'R-82',
    'provenance_key_0082',
    v_hash
  );

  if v_fresh.outcome <> 'confirmed'
     or v_fresh.response_status <> 201
     or v_fresh.replayed
     or v_replay.outcome <> 'replay'
     or not v_replay.replayed
     or v_replay.response_status <> v_fresh.response_status
     or v_replay.response_body <> v_fresh.response_body
     or v_replay.execution_started_at <> v_fresh.execution_started_at then
    raise exception 'bottle confirmation or replay drifted: fresh %, replay %',
      row_to_json(v_fresh),
      row_to_json(v_replay);
  end if;
end;
$$;

reset role;

do $$
declare
  v_item public.inventory_items%rowtype;
begin
  select * into strict v_item
  from public.inventory_items
  where wine_id = '82200000-0000-4000-8000-000000000001'
    and restaurant_id = '82100000-0000-4000-8000-000000000001';

  if v_item.quantity <> 1
     or v_item.unit_cost <> 0
     or v_item.section <> 'Reserve'
     or v_item.bin_location <> 'R-82'
     or v_item.added_via <> 'bottle_scan'::public.added_via then
    raise exception 'bottle scan inventory provenance is malformed: %',
      row_to_json(v_item);
  end if;
end;
$$;

rollback;
