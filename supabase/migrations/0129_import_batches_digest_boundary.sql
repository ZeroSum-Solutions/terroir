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
--   * `authenticated` also holds direct insert/update on import_batches and
--     import_batch_rows (0076).
-- So a caller could create two batches for one file with two distinct malformed
-- digests — or null out a valid digest — and both would skip the lock and the
-- check, defeating "at most one applied batch per file" without ever contending.
--
-- WHY THIS IS TRIGGERS AND NOT A CHECK CONSTRAINT. The obvious spelling is a
-- `not valid` CHECK, and it is WRONG here. `not valid` skips the initial
-- validation scan, but Postgres still enforces the constraint on every later
-- INSERT *and UPDATE* — including updates to the very legacy rows it is meant to
-- grandfather. Those rows are updated in normal operation (batch status
-- recomputation, and revert_import_batch's parent update), so a CHECK would make
-- every historic null-digest batch permanently unrevertable and would fail its
-- status writes. Verified against the live suite: the CHECK spelling broke six
-- existing p3-live tests that legitimately reproduce the pre-P3 no-hash path.
--
-- A trigger can distinguish the two cases a CHECK cannot: reject a BAD NEW
-- value, while leaving a row whose digest is not changing alone regardless of
-- what that digest already is.

create or replace function public.import_batches_guard_digest()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_well_formed boolean;
begin
  -- Exactly the two shapes 0128 can normalise to a file identity. Kept
  -- character-for-character in step with that function: a digest this accepts
  -- but 0128 cannot normalise would be a silent hole, and the reverse would
  -- refuse legitimate imports.
  v_well_formed := new.content_sha256 is not null
    and (
      new.content_sha256 ~ '^[0-9a-f]{64}$'
      or new.content_sha256 ~ '^overrides-v[0-9]+:[0-9a-f]{64}:[0-9a-f]{64}$'
    );

  if tg_op = 'INSERT' then
    if not v_well_formed then
      raise exception
        'import_batches.content_sha256 must identify an underlying file'
        using errcode = 'P0005';
    end if;
    return new;
  end if;

  -- UPDATE. A digest describes bytes already uploaded and hashed, so it has no
  -- legitimate reason to change. Freezing it is not cosmetic: rewriting one
  -- VALID digest into a DIFFERENT valid digest re-points a batch at another
  -- file's identity and defeats the advisory lock just as effectively as a
  -- malformed one. `is distinct from` so null-to-null is not treated as change.
  if new.content_sha256 is distinct from old.content_sha256 then
    raise exception
      'import_batches.content_sha256 is immutable (batch %)', old.id
      using errcode = 'P0005';
  end if;

  -- Deliberately NOT validating an unchanged digest here. Historic pre-0103
  -- rows carry null/unparseable values and must stay updatable: their status is
  -- recomputed and revert_import_batch updates them. This is the whole reason
  -- the rule is a trigger rather than a CHECK.
  return new;
end;
$$;

create trigger import_batches_guard_digest
  before insert or update on public.import_batches
  for each row
  execute function public.import_batches_guard_digest();

-- Second half of the bypass: a grandfathered parent stays unlockable forever, so
-- attaching NEW rows to one and applying it walks past the barrier without ever
-- inserting or updating a parent. Block new children under a parent 0128 cannot
-- normalise. Updates to existing children are deliberately left alone — apply
-- and revert both update them, and blocking that would strand historic batches
-- exactly as the CHECK spelling did.
create or replace function public.import_batch_rows_require_lockable_parent()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_parent_digest text;
begin
  select content_sha256 into v_parent_digest
    from public.import_batches
    where id = new.batch_id;

  if v_parent_digest is null
     or not (
       v_parent_digest ~ '^[0-9a-f]{64}$'
       or v_parent_digest ~ '^overrides-v[0-9]+:[0-9a-f]{64}:[0-9a-f]{64}$'
     ) then
    raise exception
      'import batch % has no normalisable file digest; it cannot accept new rows',
      new.batch_id
      using errcode = 'P0007';
  end if;

  return new;
end;
$$;

create trigger import_batch_rows_require_lockable_parent
  before insert on public.import_batch_rows
  for each row
  execute function public.import_batch_rows_require_lockable_parent();

comment on function public.import_batches_guard_digest() is
  'Rejects new batches whose digest 0128 cannot normalise, and freezes the digest thereafter, without touching grandfathered historic rows.';

comment on function public.import_batch_rows_require_lockable_parent() is
  'Stops a grandfathered unlockable batch being reused as a bypass by attaching new rows to it.';
