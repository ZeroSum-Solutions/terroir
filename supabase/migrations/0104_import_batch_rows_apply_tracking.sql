-- 0104_import_batch_rows_apply_tracking.sql
--
-- P3 §1.5/§5 (C16, C-new-2) — three additive, nullable-or-defaulted columns
-- on import_batch_rows:
--
--   apply_attempts (C16): incremented by apply_import_batch_chunk_v2
--   (0108) every time a row's per-row exception handler fires. On the
--   MAX_ROW_APPLY_ATTEMPTSth failure (3, src/domains/import/constants.ts),
--   the row's resolution flips to 'pending' so it falls out of the
--   eligibility WHERE clause automatically — without this, a permanently-
--   failing row (e.g. a numeric field overflow) is re-selected by every
--   future apply call forever, starving every eligible row behind it, and
--   the failure is never persisted anywhere for an operator to see.
--
--   last_error_message (C16): the exhausted row's final sqlerrm, read back
--   through the same pending-row UI/resolveImportBatchRow path §1.5 tier 3
--   already uses — this is the fourth DISTINCT cause of resolution =
--   'pending' (alongside lwin_status='unmatched', cost_status='missing',
--   duplicate_reason is not null), distinguished by which column is
--   populated, not by a new enum value.
--
--   duplicate_reason (§1.5 tier 2): populated by create_import_batch
--   (0107) when a row's resolved wine identity + normalized location
--   already has either an applied inventory_items row from a different,
--   already-confirmed batch, or a not-yet-applied row in a sibling batch
--   of the same session — surfaced for operator decision (resolution =
--   'pending'), never silently merged.
--
-- DOWN: drops all three columns. No data-shape concern — these are
-- additive tracking columns, dropping them just stops tracking, it can't
-- corrupt anything import_batch_rows' own CHECK constraints depend on.

alter table public.import_batch_rows
  add column apply_attempts     integer not null default 0 check (apply_attempts >= 0),
  add column last_error_message text,
  add column duplicate_reason   jsonb;

comment on column public.import_batch_rows.apply_attempts is
  'C16 (db audit 2026-08-23): times this row''s per-row exception handler '
  'in apply_import_batch_chunk has fired. At MAX_ROW_APPLY_ATTEMPTS (3), '
  'resolution flips to pending so the row stops being re-selected forever '
  'and stops starving eligible rows behind it.';

comment on column public.import_batch_rows.last_error_message is
  'C16: the sqlerrm from this row''s most recent apply attempt. Populated '
  'only once the row has exhausted its attempts and moved to '
  'resolution = pending — a fourth, distinct cause of pending alongside '
  'lwin_status=unmatched, cost_status=missing, and duplicate_reason is '
  'not null, distinguished by which column is populated.';

comment on column public.import_batch_rows.duplicate_reason is
  'P3 §1.5 tier 2: set by create_import_batch (0107) when this row''s '
  'wine identity + normalized (bin, section) already matches an applied '
  'inventory_items row from another batch, or a not-yet-applied row in a '
  'sibling batch of the same session. {type, matchedInventoryItemId | '
  'matchedRowId, existingQuantity} — never a silent merge, always '
  'resolution = pending for the operator to decide (include/exclude).';
