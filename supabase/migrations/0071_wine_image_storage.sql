-- TER-020D24 — provision tenant-scoped storage for wine hero images.
--
-- The image route writes deterministic <restaurant>/<wine> paths with
-- upsert=true, so managers need insert, update, and delete privileges only
-- inside their own restaurant prefix. The bucket is public because the wine
-- record persists a stable public URL for the cellar and published lists.

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
) values (
  'wine-images',
  'wine-images',
  true,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "managers can insert wine images" on storage.objects;
create policy "managers can insert wine images"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'wine-images'
    and public.is_member_with_role(
      (storage.foldername(name))[1]::uuid,
      'manager'
    )
  );

drop policy if exists "managers can update wine images" on storage.objects;
create policy "managers can update wine images"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'wine-images'
    and public.is_member_with_role(
      (storage.foldername(name))[1]::uuid,
      'manager'
    )
  )
  with check (
    bucket_id = 'wine-images'
    and public.is_member_with_role(
      (storage.foldername(name))[1]::uuid,
      'manager'
    )
  );

drop policy if exists "managers can delete wine images" on storage.objects;
create policy "managers can delete wine images"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'wine-images'
    and public.is_member_with_role(
      (storage.foldername(name))[1]::uuid,
      'manager'
    )
  );
