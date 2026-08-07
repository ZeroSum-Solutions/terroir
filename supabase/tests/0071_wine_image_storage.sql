-- Focused acceptance for 0071_wine_image_storage.sql.
-- Run against an isolated PostgreSQL database with migrations through 0071.

begin;

do $$
declare
  v_bucket storage.buckets%rowtype;
  v_policy_count integer;
begin
  select * into v_bucket
  from storage.buckets
  where id = 'wine-images';

  if not found
     or not v_bucket.public
     or v_bucket.file_size_limit is distinct from 10485760
     or v_bucket.allowed_mime_types is distinct from array['image/jpeg', 'image/png', 'image/webp']
  then
    raise exception 'wine-images bucket configuration is unsafe or missing';
  end if;

  select count(*) into v_policy_count
  from pg_policies
  where schemaname = 'storage'
    and tablename = 'objects'
    and policyname in (
      'managers can insert wine images',
      'managers can update wine images',
      'managers can delete wine images'
    )
    and roles = array['authenticated']
    and coalesce(qual, '') || coalesce(with_check, '')
      like '%is_member_with_role%'
    and coalesce(qual, '') || coalesce(with_check, '')
      like '%wine-images%'
    and coalesce(qual, '') || coalesce(with_check, '')
      like '%manager%';

  if v_policy_count <> 3 then
    raise exception 'wine-images storage policies do not require a manager tenant membership';
  end if;
end;
$$;

rollback;
