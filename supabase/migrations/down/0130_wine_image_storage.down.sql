-- 0130_wine_image_storage.down.sql
-- Drops the wine-images bucket policies and the bucket itself.
--
-- Objects are removed first: storage.buckets refuses to drop a bucket that
-- still holds objects, so a down migration that only deleted the row would
-- fail on any environment where a hero image had actually been uploaded.

drop policy if exists "members can delete wine images" on storage.objects;
drop policy if exists "members can update wine images" on storage.objects;
drop policy if exists "members can upload wine images" on storage.objects;

delete from storage.objects where bucket_id = 'wine-images';
delete from storage.buckets where id = 'wine-images';
