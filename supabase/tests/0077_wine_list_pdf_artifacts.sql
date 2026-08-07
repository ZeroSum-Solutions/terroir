-- TER-021E private artifact acceptance. Run after migration 0077.

begin;

do $$
declare
  v_bucket storage.buckets%rowtype;
  v_policy_count integer;
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
    and roles = array['authenticated']
    and cmd = 'SELECT'
    and qual like '%wine_list_pdf_artifact_tenant_id%'
    and qual like '%is_member%';

  if v_policy_count <> 1 then
    raise exception 'generated export read policy is missing tenant enforcement';
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

  if exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname like '%generated export%'
      and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  ) then
    raise exception 'generated exports have an authenticated mutation policy';
  end if;
end;
$$;

rollback;
