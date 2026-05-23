-- 0039_invoice_scans_status.sql -- BND-083
-- Adds status column to invoice_scans for async OCR processing tracking.
-- Status values: processing, complete, failed

alter table public.invoice_scans
  add column status text not null default 'processing';

comment on column public.invoice_scans.status is
  E'OCR processing status: processing, complete, or failed.';

create index invoice_scans_status_idx
  on public.invoice_scans (status);