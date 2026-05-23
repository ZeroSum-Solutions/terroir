-- 0041_invoice_scans_ocr_created_by.sql -- BND-090
-- Adds ocr_text (jsonb) and created_by (uuid) to invoice_scans
-- for full scan audit trail with OCR metadata and user attribution.

alter table public.invoice_scans
  add column ocr_text jsonb,
  add column created_by uuid;

comment on column public.invoice_scans.ocr_text is
  E'Raw OCR result from Azure Document Intelligence stored as JSON.';

comment on column public.invoice_scans.created_by is
  E'User who initiated the scan (references auth.users).';
