-- Reverse migration 0071. Wine-image objects are removed with their bucket.

drop policy if exists "managers can delete wine images" on storage.objects;
drop policy if exists "managers can update wine images" on storage.objects;
drop policy if exists "managers can insert wine images" on storage.objects;

delete from storage.objects where bucket_id = 'wine-images';
delete from storage.buckets where id = 'wine-images';
