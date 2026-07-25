-- Reverse migration 0065.
drop function if exists public.commit_invoice_scan_idempotent(
  uuid,
  uuid,
  text,
  text
);
