-- down for 0089_invoice_scans_updated_at.sql

drop trigger if exists invoice_scans_set_updated_at on public.invoice_scans;

alter table public.invoice_scans
  drop column if exists updated_at;
