-- Reverse of 0104_import_batch_rows_apply_tracking.sql

alter table public.import_batch_rows
  drop column if exists duplicate_reason,
  drop column if exists last_error_message,
  drop column if exists apply_attempts;
