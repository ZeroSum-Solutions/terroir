-- 0041_invoice_scans_ocr_created_by.down.sql
alter table public.invoice_scans
  drop column created_by,
  drop column ocr_text;
