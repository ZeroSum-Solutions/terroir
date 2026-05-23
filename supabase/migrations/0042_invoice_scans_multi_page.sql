-- 0042_invoice_scans_multi_page.sql -- BND-081
alter table public.invoice_scans
  add column extra_image_paths jsonb not null default '[]'::jsonb;
