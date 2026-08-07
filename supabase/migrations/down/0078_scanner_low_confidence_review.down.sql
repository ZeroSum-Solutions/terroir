drop function if exists public.commit_reviewed_invoice_scan_idempotent(
  uuid,
  uuid,
  boolean,
  text,
  text
);

grant execute on function public.commit_invoice_scan_idempotent(
  uuid,
  uuid,
  text,
  text
) to authenticated;

alter table public.invoice_scans
  drop column if exists low_confidence_reviewed_by,
  drop column if exists low_confidence_reviewed_at;
