-- TER-021E private artifact acceptance. Run after migration 0077.

begin;

insert into auth.users (
  id, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '77000000-0000-4000-8000-000000000001',
  'pdf-artifact-member@example.test',
  '{}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
);
insert into public.restaurants (id, name) values
  ('77100000-0000-4000-8000-000000000001', 'PDF Artifact Tenant'),
  ('77100000-0000-4000-8000-000000000002', 'Other PDF Tenant');
insert into public.memberships (user_id, restaurant_id, role) values (
  '77000000-0000-4000-8000-000000000001',
  '77100000-0000-4000-8000-000000000001',
  'owner'
);
insert into public.wine_lists (id, restaurant_id, name) values
  (
    '77200000-0000-4000-8000-000000000001',
    '77100000-0000-4000-8000-000000000001',
    'Tenant List'
  ),
  (
    '77200000-0000-4000-8000-000000000002',
    '77100000-0000-4000-8000-000000000002',
    'Other Tenant List'
  );
select set_config(
  'request.jwt.claim.sub',
  '77000000-0000-4000-8000-000000000001',
  true
);

do $$
declare
  v_bucket storage.buckets%rowtype;
  v_policy_count integer;
  v_validator_definition text;
begin
  select * into v_bucket
  from storage.buckets
  where id = 'generated-exports';

  if v_bucket.id is null
     or v_bucket.public
     or v_bucket.file_size_limit is distinct from 10485760
     or v_bucket.allowed_mime_types is distinct from array['application/pdf']::text[] then
    raise exception 'generated-exports bucket is missing or unsafe';
  end if;

  select count(*) into v_policy_count
  from pg_policies
  where schemaname = 'storage'
    and tablename = 'objects'
    and policyname = 'members can read generated exports'
    and roles = array['authenticated']::name[]
    and cmd = 'SELECT'
    and qual like '%wine_list_pdf_artifact_tenant_id%';

  if v_policy_count <> 1 then
    raise exception 'generated export read policy is missing tenant enforcement';
  end if;

  select pg_get_functiondef(
    'public.wine_list_pdf_artifact_tenant_id(text)'::regprocedure
  ) into v_validator_definition;
  if v_validator_definition not like '%public.is_member(v_parts[1]::uuid)%' then
    raise exception 'generated export path validator does not enforce membership';
  end if;

  if public.wine_list_pdf_artifact_tenant_id(
    '00000000-0000-4000-8000-000000000000/00000000-0000-4000-8000-000000000000_classic.pdf'
  ) is not null
     or public.wine_list_pdf_artifact_tenant_id('../escape.pdf') is not null
     or public.wine_list_pdf_artifact_tenant_id(
       '00000000-0000-4000-8000-000000000000/00000000-0000-4000-8000-000000000000_other.pdf'
     ) is not null then
    raise exception 'generated export path validator accepted an unsafe path';
  end if;

  if public.wine_list_pdf_artifact_tenant_id(
    '77100000-0000-4000-8000-000000000001/77200000-0000-4000-8000-000000000001_classic.pdf'
  ) is distinct from '77100000-0000-4000-8000-000000000001'::uuid then
    raise exception 'generated export validator rejected a member path';
  end if;
  if public.wine_list_pdf_artifact_tenant_id(
    '77100000-0000-4000-8000-000000000002/77200000-0000-4000-8000-000000000002_classic.pdf'
  ) is not null then
    raise exception 'generated export validator exposed a non-member path';
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
      and (
        coalesce(qual, '') like '%generated-exports%'
        or coalesce(with_check, '') like '%generated-exports%'
      )
  ) then
    raise exception 'generated exports have an authenticated mutation policy';
  end if;
end;
$$;

rollback;
