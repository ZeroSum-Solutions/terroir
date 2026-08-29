-- 0130_wine_image_storage.sql
-- Create the storage bucket wine hero images have always been written to.
--
-- src/domains/cellar/wine-image-service.ts has uploaded to `wine-images`
-- since BND-057, but no migration ever created the bucket — it existed only
-- where someone had made it by hand. A fresh environment (a new local stack,
-- a restore drill, a second project) therefore had a hero-image upload that
-- could only fail. This is that bucket, declared.
--
-- Public, unlike `invoice-images` (0009): a hero image is a bottle label, and
-- its URL is stored in wines.hero_image_url and rendered directly by
-- next/image. An invoice is a financial document and stays private behind a
-- signed-URL route.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'wine-images',
  'wine-images',
  true,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

-- Writes stay restaurant-scoped even though reads are public: objects live at
-- {restaurant_id}/{...}, and only a member of that restaurant may create,
-- replace or remove one.
create policy "members can upload wine images"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'wine-images'
    and public.is_member((storage.foldername(name))[1]::uuid)
  );

create policy "members can update wine images"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'wine-images'
    and public.is_member((storage.foldername(name))[1]::uuid)
  );

create policy "members can delete wine images"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'wine-images'
    and public.is_member((storage.foldername(name))[1]::uuid)
  );
