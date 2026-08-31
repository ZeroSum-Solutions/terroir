-- Down for 0143 — removes the invoice-scan delete path entirely.
--
-- Reverting takes the product back to the state D6 was written to fix: no
-- way to delete an invoice scan at all (the DELETE policy disappears, so a
-- DELETE against invoice_scans silently matches zero rows again), and no
-- column in which to state WHY a zero-item or failed scan is in the ledger.
--
-- The audit table is dropped WITH ITS ROWS. Every row in it names a scan
-- that no longer exists, so nothing else in the schema can carry that
-- history forward — if the deletions that happened while 0143 was in force
-- matter, export public.invoice_scan_deletions BEFORE running this.
--
-- Inventory already reversed by delete_invoice_scan is not restored: those
-- rows were deleted on a user's explicit, confirmed instruction, exactly as
-- revert_import_batch's own reversals are.

drop function if exists public.delete_invoice_scan(uuid);

drop table if exists public.invoice_scan_deletions;

drop policy if exists "managers can delete their scans" on public.invoice_scans;

alter table public.invoice_scans
  drop column if exists status_reason;
