-- TER-024 follow-up: provision both governed buckets even when an environment
-- is missing an earlier data migration. The privacy contract must not depend
-- on a bucket already existing before it can make that bucket private.

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
) values
  (
    'invoice-images',
    'invoice-images',
    false,
    10485760,
    array['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'application/pdf']
  ),
  (
    'wine-images',
    'wine-images',
    false,
    10485760,
    array['image/jpeg', 'image/png', 'image/webp']
  )
on conflict (id) do update
set
  name = excluded.name,
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
