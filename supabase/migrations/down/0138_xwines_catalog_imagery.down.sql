-- 0138_xwines_catalog_imagery.down.sql
-- Removes the corpus imagery columns.
--
-- The stored objects are deliberately NOT deleted. They live in the
-- `wine-images` bucket under `catalog/<source>/…`, which 0130 owns and whose
-- own down migration already empties; deleting them here would also destroy
-- the tenant hero images sharing that bucket if the two downs ever ran in the
-- wrong order. Dropping the columns is enough to un-say the claim.

drop index if exists public.xwines_catalog_image_kind_idx;

alter table public.xwines_catalog
  drop constraint if exists xwines_catalog_image_complete,
  drop constraint if exists xwines_catalog_image_kind_known;

alter table public.xwines_catalog
  drop column if exists image_credit,
  drop column if exists image_source,
  drop column if exists image_kind,
  drop column if exists image_url;
