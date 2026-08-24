-- down for 0090_invoice_scans_committed_at.sql

alter table public.invoice_scans
  drop column if exists committed_at;
