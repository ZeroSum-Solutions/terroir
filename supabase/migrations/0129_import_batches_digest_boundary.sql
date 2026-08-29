-- 0129 — close the bypass Sol's audit found in 0128's barrier.
--
-- 0128 takes an advisory lock keyed by the batch's UNDERLYING FILE digest and
-- re-checks for an applied sibling under that lock. It deliberately skips rows
-- whose content_sha256 is null or malformed, because their file identity cannot
-- be recovered — those were understood to be historic pre-0103 rows.
--
-- That characterisation was wrong. Nothing stopped a CURRENT caller from
-- MANUFACTURING that state:
--   * create_import_batch (0107) takes p_content_sha256 with a `default null`
--     and never validates it, and is granted to `authenticated`;
--   * `authenticated` also holds direct insert/update on import_batches
--     (0076), including content_sha256.
-- So a caller could create two batches for one file with two distinct malformed
-- digests — or null out a valid digest — and call the apply RPC directly. Both
-- skip the lock and the check, and the "at most one applied batch per file"
-- invariant is defeated without ever contending.
--
-- The fix is a boundary in the database, not in the route: NEW values must be
-- well-formed, and a digest may not be mutated once written. Existing rows are
-- preserved untouched — `not valid` grandfathers them exactly as 0128 intended,
-- while still enforcing on every future insert and update.

-- A CHECK constraint whose expression evaluates to NULL PASSES. Spelling the
-- null case out explicitly is therefore load-bearing: `content_sha256 ~ '...'`
-- alone would admit every null and leave the reported bypass wide open.
alter table public.import_batches
  add constraint import_batches_content_sha256_well_formed
  check (
    content_sha256 is not null
    and (
      content_sha256 ~ '^[0-9a-f]{64}$'
      or content_sha256 ~ '^overrides-v[0-9]+:[0-9a-f]{64}:[0-9a-f]{64}$'
    )
  )
  not valid;

-- The constraint alone still permits rewriting one VALID digest into a
-- DIFFERENT valid digest, which re-opens the same hole: point batch A at file
-- B's identity and the pair stops contending on the advisory lock. The digest
-- describes bytes that were already uploaded and hashed, so it has no
-- legitimate reason to change after insert.
create or replace function public.import_batches_freeze_content_sha256()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- `is distinct from` so a null-to-null update is not treated as a change.
  if new.content_sha256 is distinct from old.content_sha256 then
    raise exception
      'import_batches.content_sha256 is immutable (batch %)', old.id
      using errcode = 'P0005';
  end if;
  return new;
end;
$$;

create trigger import_batches_freeze_content_sha256
  before update on public.import_batches
  for each row
  execute function public.import_batches_freeze_content_sha256();

comment on constraint import_batches_content_sha256_well_formed
  on public.import_batches is
  'New batches must carry a digest 0128''s barrier can normalise to a file identity. `not valid` grandfathers historic pre-0103 rows.';

comment on function public.import_batches_freeze_content_sha256() is
  'Blocks content_sha256 mutation so a batch cannot be re-pointed at another file''s identity to escape 0128''s advisory lock.';
