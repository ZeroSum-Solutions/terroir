-- TER-024 acceptance. Run against an isolated database after migration 0075.

begin;

do $$
declare
  v_bucket storage.buckets%rowtype;
  v_bucket_count integer := 0;
  v_policy_count integer;
  v_set_null_count integer;
begin
  for v_bucket in
    select *
    from storage.buckets
    where id in ('invoice-images', 'wine-images')
  loop
    v_bucket_count := v_bucket_count + 1;
    if v_bucket.id is null
       or v_bucket.public
       or v_bucket.file_size_limit is distinct from 10485760 then
      raise exception 'TER-024 storage bucket is public, missing, or has the wrong size limit';
    end if;
  end loop;

  if v_bucket_count <> 2 then
    raise exception 'TER-024 storage buckets are missing';
  end if;

  select count(*) into v_policy_count
  from pg_policies
  where schemaname = 'storage'
    and tablename = 'objects'
    and policyname in (
      'members can upload invoice images',
      'members can update invoice images',
      'owners can delete invoice images',
      'members can read wine images',
      'managers can insert wine images',
      'managers can update wine images',
      'managers can delete wine images'
    )
    and roles = array['authenticated']
    and coalesce(qual, '') || coalesce(with_check, '')
      like '%storage_tenant_prefix_id%';

  if v_policy_count <> 7 then
    raise exception 'TER-024 Storage policies lack authenticated tenant enforcement';
  end if;

  if public.is_valid_invoice_image_path(
    '00000000-0000-4000-8000-000000000000/00000000-0000-4000-8000-000000000000.pdf'
  )
     or public.is_valid_wine_image_path(
       '00000000-0000-4000-8000-000000000000/00000000-0000-4000-8000-000000000000.jpg'
     ) then
    raise exception 'TER-024 path validator accepted a resource that does not exist';
  end if;

  select count(*) into v_set_null_count
  from pg_constraint
  where conname in (
    'invitations_invited_by_fkey',
    'invoice_scans_created_by_fkey',
    'wines_eightysixed_by_fkey',
    'availability_events_user_id_fkey',
    'open_bottles_opened_by_fkey',
    'pour_events_actor_user_id_fkey'
  )
    and confdeltype = 'n';

  if v_set_null_count <> 6 then
    raise exception 'TER-024 user-attribution foreign keys do not all use ON DELETE SET NULL';
  end if;
end;
$$;

rollback;
