-- Reverses 0129. Existing rows are untouched by both directions: the forward
-- migration is `not valid` and adds no data, so dropping it cannot fail and
-- cannot lose anything.
drop trigger if exists import_batches_freeze_content_sha256 on public.import_batches;
drop function if exists public.import_batches_freeze_content_sha256();
alter table public.import_batches
  drop constraint if exists import_batches_content_sha256_well_formed;
