-- 0143_invoice_scan_deletion.sql
--
-- SCAN-04 / decision D6 (docs/plans/2026-08-30-field-walk-decisions.md):
-- the invoice ledger keeps every scan, including the ones that found
-- nothing and the ones that failed, and deleting one is an explicit,
-- confirmed act that first reverses whatever inventory that scan created.
--
-- Three things are missing from the schema before this migration, and all
-- three are required by that decision:
--
-- 1. THERE IS NO REASON COLUMN. A zero-item scan is persisted as
--    `status = 'complete', item_count = 0`
--    (src/domains/scanning/invoice-scan-service.ts:136-150) and a failed one
--    as `status = 'failed'` (:301-310). Neither carries WHY, so the ledger
--    can show that a row exists but not what happened to it — exactly the
--    "stays visible, with a stated reason" half of D6 rule 1.
--    `status_reason` is a short machine code (`no_wines_extracted`,
--    `ocr_upstream_error`, …) rendered as prose by the UI; it is nullable
--    because every row written before this migration has no reason to state.
--
-- 2. THERE IS NO DELETE POLICY. `invoice_scans` has shipped with SELECT
--    (0002) + INSERT (0002) + UPDATE (0066) policies and nothing else, so
--    every DELETE against it under a user session matched zero rows and
--    returned success. That silence is not only why there is no delete
--    feature — it is also why the two error-path rollbacks in
--    POST /api/inventory/save-scan were no-ops that left orphan rows in the
--    ledger. (Those two call sites are removed in the same change: under
--    D6 rule 1 a failed save must STAY in the ledger with a stated reason,
--    not disappear, so the correct repair there is an UPDATE, not a DELETE
--    that finally works.) The policy is scoped to `manager` — the same
--    hierarchy-aware helper the other manager-scoped write policies use
--    (`member_restaurant_ids_with_role`, 0084), so owners satisfy it and
--    staff do not. Deleting an invoice destroys inventory; that is not a
--    staff-level act.
--
-- 3. THERE IS NO AUDIT TRAIL. D6 requires the deletion to be audited, and
--    once the scan row is gone there is nothing left to read. Deliberately
--    NOT an FK to `invoice_scans` — the row it names has just been deleted.
--
-- SAFE AGAINST OLD CODE (AGENTS.md non-negotiable 7) — WITH ONE EXCEPTION,
-- STATED PLAINLY. Every object here is additive: a nullable column, one new
-- policy, one new table, one new function. But an earlier draft of this header
-- claimed "code running against this database before the deploy behaves
-- exactly as it did", and that is FALSE, as an adversarial review of this
-- branch pointed out. The new DELETE policy changes the behaviour of code that
-- is already deployed.
--
-- WHAT CHANGES. Before this migration, `invoice_scans` had SELECT + INSERT
-- (0002) and UPDATE (0066) policies and no DELETE policy, so every DELETE
-- under a user session matched zero rows and returned success. The version of
-- POST /api/inventory/save-scan currently in production contains two such
-- deletes — at :262 (after `find_or_create_wines_batch` fails) and :291 (after
-- the `inventory_items` insert fails). Both are no-ops today. The moment this
-- policy exists they start deleting rows for real, and per
-- docs/runbooks/production-migrations.md migrations are applied BEFORE the code
-- that depends on them, so that window is guaranteed rather than hypothetical.
--
-- HOW BAD, MEASURED RATHER THAN ASSUMED. The review's stated consequence was
-- orphaned inventory: `inventory_items.invoice_scan_id` is ON DELETE SET NULL,
-- so deleting a scan unlinks its stock instead of removing it. That outcome
-- does NOT occur at either site. :262 fires before any inventory is written.
-- :291 fires after a single batch `.insert(array)`, which PostgREST executes as
-- one atomic INSERT — on failure no rows exist. So there is no successfully
-- written inventory to orphan at either point.
--
-- What actually happens in the window is narrower: a failed save deletes its
-- ledger row instead of leaving it visible with a stated reason. That is
-- pre-D6 behaviour continuing a little longer, not data loss — and it is
-- arguably tidier than today's outcome, where the no-op delete leaves an orphan
-- ledger row behind (the defect this branch also fixes). Both sites are removed
-- in the same change; they become `markInvoiceScanSaveFailed()` calls, because
-- under D6 rule 1 a failed save must STAY in the ledger with a reason.
--
-- NOTHING TO DO DIFFERENTLY, BUT KNOW IT: applying this migration before the
-- deploy is safe. The claim that behaviour is unchanged was the error, not the
-- migration.

-- ── 1. The stated reason ────────────────────────────────────────────────
alter table public.invoice_scans
  add column status_reason text;

comment on column public.invoice_scans.status_reason is
  'D6 rule 1: WHY this scan is in its current status — a short machine '
  'code the UI renders as prose (no_wines_extracted, arithmetic_mismatch, '
  'ocr_upstream_error, ai_parse_failed, inventory_save_failed, ...). Null '
  'for a scan that needs no explanation (an ordinary complete scan) and '
  'for every row written before 0143.';

-- ── 2. The delete policy ────────────────────────────────────────────────
create policy "managers can delete their scans"
  on public.invoice_scans for delete to authenticated
  using (restaurant_id in (select public.member_restaurant_ids_with_role('manager')));

-- ── 3. The audit trail ──────────────────────────────────────────────────
create table public.invoice_scan_deletions (
  id                    uuid        primary key default gen_random_uuid(),
  restaurant_id         uuid        not null references public.restaurants(id) on delete cascade,
  -- No FK: the scan this names is deleted in the same transaction.
  invoice_scan_id       uuid        not null,
  deleted_by            uuid        references auth.users(id) on delete set null,
  deleted_at            timestamptz not null default now(),
  distributor_name      text        not null,
  invoice_number        text,
  scan_status           text        not null,
  item_count            int         not null,
  inventory_rows_deleted int        not null,
  bottles_removed       int         not null,
  -- The line items as they stood at deletion, so the audit row is a real
  -- record of what was destroyed rather than a count of it.
  final_line_items      jsonb       not null
);

create index invoice_scan_deletions_restaurant_idx
  on public.invoice_scan_deletions (restaurant_id, deleted_at desc);

alter table public.invoice_scan_deletions enable row level security;

create policy "members can read their scan deletions"
  on public.invoice_scan_deletions for select to authenticated
  using (restaurant_id in (select public.member_restaurant_ids()));

-- INSERT is gated on the same role that may delete a scan, and on the row
-- naming its own author — delete_invoice_scan below writes auth.uid()
-- itself, so this `with check` makes a forged author impossible even
-- through a direct PostgREST insert.
create policy "managers can insert their scan deletions"
  on public.invoice_scan_deletions for insert to authenticated
  with check (
    restaurant_id in (select public.member_restaurant_ids_with_role('manager'))
    and deleted_by = auth.uid()
  );

-- Table privileges, NOT just policies. 0074 granted DML on all *existing*
-- public tables to authenticated/service_role and set a default-privileges
-- rule for service_role only, so a table created afterwards is unreachable
-- to `authenticated` no matter how permissive its policies are — Postgres
-- checks the grant BEFORE the policy, and the failure reads as
-- "permission denied for table", which looks like a policy bug and is not
-- one. Same trap 0131 documents. Verified live: without these two lines
-- delete_invoice_scan aborts at the audit insert.
--
-- SELECT + INSERT only. The table is append-only by design, so UPDATE and
-- DELETE are withheld from `authenticated` at the privilege layer as well
-- as by having no policy.
grant select, insert on public.invoice_scan_deletions to authenticated;
grant select, insert, update, delete on public.invoice_scan_deletions to service_role;

comment on table public.invoice_scan_deletions is
  'SCAN-04 / D6: one row per explicitly-deleted invoice scan, recording who '
  'deleted it, what it claimed, and how much inventory the deletion '
  'reversed. Append-only by policy (no UPDATE or DELETE policy exists).';

-- ── 4. The delete + inventory reversal, in one transaction ──────────────
--
-- WHY THIS IS NOT revert_import_batch (0109). That function reverses an
-- IMPORT: it walks `import_batch_rows` where `apply_status = 'applied'` and
-- deletes the single `inventory_items` row each one recorded in
-- `applied_inventory_item_id`, then flips the batch to 'reverted'. An
-- invoice scan has no `import_batches` row, no `import_batch_rows`, and no
-- per-row applied-id column — the only link from a scan to the inventory it
-- created is `inventory_items.invoice_scan_id`, written by both
-- POST /api/inventory/save-scan and POST /api/scans/[id]/commit. There is
-- no shape of argument that makes 0109 accept a scan id. This function is
-- therefore the narrowest equivalent for the other write path, deliberately
-- mirroring 0109's rules rather than inventing new ones:
--   * it deletes ONLY rows this scan created (`invoice_scan_id = p_scan_id`),
--     never other inventory for the same wine or restaurant;
--   * it never touches `wines` (0109 leaves orphan-wine cleanup to a
--     separate best-effort pass, and a wine with no stock is a catalog
--     entry, not garbage);
--   * `deleted_by` is `auth.uid()`, never a client-supplied value.
--
-- ORDER IS LOAD-BEARING: `inventory_items.invoice_scan_id` references
-- `invoice_scans(id) ON DELETE SET NULL` (0002). Deleting the scan first
-- would null the link on every one of its inventory rows, permanently
-- orphaning stock that the user asked to have removed. Inventory goes
-- first, always.
create or replace function public.delete_invoice_scan(p_scan_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_restaurant_id uuid;
  v_distributor text;
  v_invoice_number text;
  v_status text;
  v_item_count int;
  v_final jsonb;
  v_rows int := 0;
  v_bottles int := 0;
begin
  select restaurant_id, distributor_name, invoice_number, status, item_count, final_line_items
    into v_restaurant_id, v_distributor, v_invoice_number, v_status, v_item_count, v_final
  from public.invoice_scans
  where id = p_scan_id
  for update;

  if not found then
    -- RLS already narrowed this to "scans I can read", so another tenant's
    -- scan id is indistinguishable from a nonexistent one. That is the point.
    raise exception 'invoice scan % not found', p_scan_id using errcode = 'P0002';
  end if;

  -- Checked explicitly rather than left to the DELETE policy alone: without
  -- it a staff caller would do the whole inventory reversal and only then
  -- hit a zero-row scan delete. The transaction would still roll back, but
  -- the caller deserves the real reason, not "could not be deleted".
  if not public.is_member_with_role(v_restaurant_id, 'manager') then
    raise exception 'insufficient privilege to delete invoice scan %', p_scan_id
      using errcode = 'P0003';
  end if;

  select count(*), coalesce(sum(quantity), 0)
    into v_rows, v_bottles
  from public.inventory_items
  where invoice_scan_id = p_scan_id
    and restaurant_id = v_restaurant_id;

  delete from public.inventory_items
  where invoice_scan_id = p_scan_id
    and restaurant_id = v_restaurant_id;

  insert into public.invoice_scan_deletions (
    restaurant_id, invoice_scan_id, deleted_by, distributor_name,
    invoice_number, scan_status, item_count, inventory_rows_deleted,
    bottles_removed, final_line_items
  ) values (
    v_restaurant_id, p_scan_id, auth.uid(), v_distributor,
    v_invoice_number, v_status, v_item_count, v_rows,
    v_bottles, coalesce(v_final, '[]'::jsonb)
  );

  delete from public.invoice_scans where id = p_scan_id;
  if not found then
    raise exception 'invoice scan % could not be deleted', p_scan_id
      using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'scanId', p_scan_id,
    'inventoryRowsDeleted', v_rows,
    'bottlesRemoved', v_bottles
  );
end;
$$;

comment on function public.delete_invoice_scan(uuid) is
  'SCAN-04 / D6: deletes one invoice scan after reversing exactly the '
  'inventory_items rows that scan created (invoice_scan_id = p_scan_id), '
  'in one transaction, and records the deletion in '
  'invoice_scan_deletions. Never touches wines, never touches inventory '
  'from another scan or another source. Inventory is deleted BEFORE the '
  'scan row because inventory_items.invoice_scan_id is ON DELETE SET NULL '
  'and the reverse order would orphan the stock instead of removing it. '
  'Returns {scanId, inventoryRowsDeleted, bottlesRemoved}.';

revoke all on function public.delete_invoice_scan(uuid) from public;
grant execute on function public.delete_invoice_scan(uuid) to authenticated;
