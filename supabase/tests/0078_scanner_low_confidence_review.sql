-- Focused acceptance for 0078_scanner_low_confidence_review.sql.
-- Run against an isolated migrated database only:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f supabase/tests/0078_scanner_low_confidence_review.sql

begin;

insert into auth.users (
  id,
  email,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
) values (
  '78000000-0000-4000-8000-000000000001',
  'scanner-reviewer-0078@example.test',
  '{}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
);

insert into public.restaurants (id, name) values (
  '78000000-0000-4000-8000-000000000002',
  'Scanner Review Acceptance'
);

insert into public.memberships (id, user_id, restaurant_id, role) values (
  '78000000-0000-4000-8000-000000000003',
  '78000000-0000-4000-8000-000000000001',
  '78000000-0000-4000-8000-000000000002',
  'staff'
);

insert into public.invoice_scans (
  id,
  restaurant_id,
  distributor_name,
  parsed_line_items,
  final_line_items,
  item_count,
  status
) values
  (
    '78000000-0000-4000-8000-000000000010',
    '78000000-0000-4000-8000-000000000002',
    'Low Confidence Fixture',
    '[]'::jsonb,
    '[{
      "id":"low-line",
      "name":"Review Cuvee",
      "producer":"Review Producer",
      "vintage":2020,
      "varietal":"Blend",
      "region":"Test Region",
      "qty":1,
      "unitCost":25,
      "currency":"USD",
      "format":"750ml",
      "confidence":0.7,
      "lowFields":["producer"]
    }]'::jsonb,
    1,
    'complete'
  ),
  (
    '78000000-0000-4000-8000-000000000011',
    '78000000-0000-4000-8000-000000000002',
    'High Confidence Fixture',
    '[]'::jsonb,
    '[{
      "id":"high-line",
      "name":"Clear Cuvee",
      "producer":"Clear Producer",
      "vintage":2021,
      "varietal":"Blend",
      "region":"Test Region",
      "qty":2,
      "unitCost":30,
      "currency":"USD",
      "format":"750ml",
      "confidence":0.99
    }]'::jsonb,
    1,
    'complete'
  );

do $$
begin
  if has_function_privilege(
    'authenticated',
    'public.commit_invoice_scan_idempotent(uuid,uuid,text,text)',
    'EXECUTE'
  ) then
    raise exception 'authenticated can bypass the review wrapper';
  end if;
  if not has_function_privilege(
    'authenticated',
    'public.commit_reviewed_invoice_scan_idempotent(uuid,uuid,boolean,text,text)',
    'EXECUTE'
  ) then
    raise exception 'authenticated lacks the reviewed commit wrapper';
  end if;
end;
$$;

select set_config(
  'request.jwt.claim.sub',
  '78000000-0000-4000-8000-000000000001',
  false
);
set role authenticated;

do $$
declare
  v_result record;
begin
  select * into v_result
  from public.commit_reviewed_invoice_scan_idempotent(
    '78000000-0000-4000-8000-000000000002',
    '78000000-0000-4000-8000-000000000010',
    false
  );
  if v_result.outcome <> 'review_required'
     or v_result.response_status <> 422 then
    raise exception 'unreviewed low-confidence scan was not blocked: %',
      row_to_json(v_result);
  end if;

  select * into v_result
  from public.commit_reviewed_invoice_scan_idempotent(
    '78000000-0000-4000-8000-000000000002',
    '78000000-0000-4000-8000-000000000010',
    true
  );
  if v_result.outcome <> 'committed'
     or v_result.response_status <> 200 then
    raise exception 'reviewed low-confidence scan did not commit: %',
      row_to_json(v_result);
  end if;

  select * into v_result
  from public.commit_reviewed_invoice_scan_idempotent(
    '78000000-0000-4000-8000-000000000002',
    '78000000-0000-4000-8000-000000000011',
    false
  );
  if v_result.outcome <> 'committed'
     or v_result.response_status <> 200 then
    raise exception 'high-confidence scan required unnecessary review: %',
      row_to_json(v_result);
  end if;
end;
$$;

reset role;

do $$
begin
  if not exists (
    select 1
    from public.invoice_scans
    where id = '78000000-0000-4000-8000-000000000010'
      and low_confidence_reviewed_at is not null
      and low_confidence_reviewed_by =
        '78000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'review audit was not recorded';
  end if;

  if (
    select count(*)
    from public.inventory_items
    where invoice_scan_id in (
      '78000000-0000-4000-8000-000000000010',
      '78000000-0000-4000-8000-000000000011'
    )
  ) <> 2 then
    raise exception 'reviewed commits did not create exactly two inventory rows';
  end if;
end;
$$;

rollback;
