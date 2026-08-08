-- Acceptance for integrated enqueue authorization hardening.
-- Run only against an isolated migrated database; this transaction rolls back.

begin;

insert into auth.users (
  id, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '86000000-0000-4000-8000-000000000001',
    'manager-0086@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    '86000000-0000-4000-8000-000000000002',
    'staff-0086@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()
  );

insert into public.restaurants (id, name) values
  ('86100000-0000-4000-8000-000000000001', 'Enqueue Authority Tenant');

insert into public.memberships (user_id, restaurant_id, role) values
  (
    '86000000-0000-4000-8000-000000000001',
    '86100000-0000-4000-8000-000000000001', 'manager'
  ),
  (
    '86000000-0000-4000-8000-000000000002',
    '86100000-0000-4000-8000-000000000001', 'staff'
  );

select set_config(
  'request.jwt.claim.sub',
  '86000000-0000-4000-8000-000000000001',
  false
);
select set_config('request.jwt.claim.role', 'authenticated', false);
set local role authenticated;
do $$
declare
  v_job public.background_jobs;
begin
  select * into v_job from public.enqueue_background_job(
    '86100000-0000-4000-8000-000000000001',
    'wine_enrichment',
    'manager-wine-enrichment-0086',
    'restaurants',
    '86100000-0000-4000-8000-000000000001',
    '{"scope":"restaurant"}'::jsonb,
    3,
    now()
  );

  if v_job.id is null or v_job.created_by <> auth.uid() then
    raise exception 'manager wine enrichment enqueue did not persist';
  end if;
end;
$$;
reset role;

select set_config(
  'request.jwt.claim.sub',
  '86000000-0000-4000-8000-000000000002',
  false
);
select set_config('request.jwt.claim.role', 'authenticated', false);
set local role authenticated;
do $$
begin
  begin
    perform public.enqueue_background_job(
      '86100000-0000-4000-8000-000000000001',
      'wine_enrichment',
      'staff-wine-enrichment-0086',
      'restaurants',
      '86100000-0000-4000-8000-000000000001',
      '{"scope":"restaurant"}'::jsonb,
      3,
      now()
    );
  exception when sqlstate '42501' then
    return;
  end;
  raise exception 'staff wine enrichment enqueue unexpectedly succeeded';
end;
$$;

do $$
declare
  v_job public.background_jobs;
begin
  select * into v_job from public.enqueue_background_job(
    '86100000-0000-4000-8000-000000000001',
    'invoice_ocr',
    'staff-invoice-ocr-0086',
    'invoice_scans',
    '86200000-0000-4000-8000-000000000001',
    '{}'::jsonb,
    3,
    now()
  );

  if v_job.id is null or v_job.created_by <> auth.uid() then
    raise exception 'staff invoice OCR enqueue did not remain allowed';
  end if;
end;
$$;
reset role;

do $$
begin
  if exists (
    select 1
    from public.background_jobs
    where idempotency_key = 'staff-wine-enrichment-0086'
  ) then
    raise exception 'denied staff enqueue persisted a job';
  end if;
end;
$$;

rollback;
