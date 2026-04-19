-- 0009_invoice_image_storage.sql
-- Create storage bucket for invoice images and set up RLS policies.

-- Create the bucket (private, 20 MB limit)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'invoice-images',
  'invoice-images',
  false,
  20971520,
  array['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'application/pdf']
);

-- RLS: members can upload images scoped to their restaurant
create policy "members can upload invoice images"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'invoice-images'
    and public.is_member((storage.foldername(name))[1]::uuid)
  );

-- RLS: members can read images scoped to their restaurant
create policy "members can read invoice images"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'invoice-images'
    and public.is_member((storage.foldername(name))[1]::uuid)
  );
