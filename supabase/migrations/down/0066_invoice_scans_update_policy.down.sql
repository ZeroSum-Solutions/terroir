-- Down for 0066_invoice_scans_update_policy.sql

drop policy if exists "members can update their scans" on public.invoice_scans;
