-- 0085_import_batch_bin_id.sql
--
-- C11 (db audit 2026-08-23, verified V2-import.md) — apply_import_batch_chunk
-- writes inventory_items.bin_location from the CSV's `bin` cell but never
-- resolves/sets inventory_items.bin_id, even when a `bins` row with that
-- exact code already exists for the restaurant (0057 made bins the
-- physical key; bin_location is legacy free text kept for display/backfill
-- only). Verified reproduction: pre-created a real bins row (code
-- 'R4-S12'), applied a CSV row whose bin cell was exactly 'R4-S12' through
-- the real RPC — the resulting inventory_items row had
-- bin_location='R4-S12', bin_id=NULL.
--
-- Consequence (traced to real consumers, not assumed):
--   - src/app/(app)/bins/page.tsx's "Unplaced" count and
--     src/lib/reconcile-ledger/queue-sources.ts's reconcile queue both key
--     off inventory_items.bin_id IS NULL. A faithful 20k-row import whose
--     CSV bin column matches existing bins would still show 100% of the
--     imported cellar as unplaced and flood the reconcile queue.
--
-- Fix, scoped to what was verified:
--   1. apply_import_batch_chunk now looks up an existing public.bins row
--      for the row's restaurant using the same case-insensitive,
--      btrim-normalized code comparison 0057's own backfill used
--      (upper(btrim(...)) there; lower() here is equivalent for matching
--      since bins_restaurant_code_idx is itself a lower(code) unique
--      index) and sets inventory_items.bin_id when found.
--   2. A one-time backfill UPDATE closes the gap for rows already applied
--      by the pre-fix function (this repo has been live on 0076 since
--      before this fix; historic imported rows are broken the same way).
--
-- Deliberately NOT done: auto-creating a NEW bins row when no match
-- exists. public.bins' own INSERT policy ("managers can insert bins",
-- 0057) restricts bin creation to managers, but apply_import_batch_chunk
-- is SECURITY INVOKER and callable by any restaurant member (staff+) via
-- requireMembership() with no role gate (src/app/api/import/batches/[id]/
-- apply/route.ts) — auto-creating bins from CSV text here would let staff
-- silently bypass that manager-only rule. The verified bug is specifically
-- "an EXISTING matching bin isn't linked"; a CSV bin code with no existing
-- bins row correctly stays unplaced today (nothing physical to link to
-- yet) and is out of scope for this fix.
--
-- DOWN: restores apply_import_batch_chunk to its pre-fix (0082) body, and
-- re-nulls bin_id for any row whose bin_id currently resolves via the same
-- code match this migration performs (the same criteria, run in reverse —
-- see down/0085_import_batch_bin_id.down.sql for the exact caveat).

-- ── 1. Backfill: link already-applied rows to their existing matching bin ──
update public.inventory_items i
   set bin_id = b.id
  from public.bins b
 where i.bin_id is null
   and i.bin_location is not null
   and btrim(i.bin_location) <> ''
   and b.restaurant_id = i.restaurant_id
   and lower(b.code) = lower(btrim(i.bin_location));

-- ── 2. apply_import_batch_chunk: resolve bin_id for future applies ────────
create or replace function public.apply_import_batch_chunk(p_batch_id uuid, p_limit integer default 50)
returns table (
  row_id            uuid,
  row_number        integer,
  outcome           text,
  inventory_item_id uuid,
  error_message     text
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row public.import_batch_rows%rowtype;
  v_unit_cost numeric(10,2);
  v_wine_id uuid;
  v_inventory_id uuid;
  v_bin_id uuid;
begin
  -- C17: re-validate the batch's own tenant before processing any rows.
  -- RLS on import_batches already filters this to "batches I'm a member
  -- of" (the same idiom revert_import_batch, 0076, uses) — a batch id
  -- belonging to another restaurant is simply invisible here, which reads
  -- identically to a nonexistent one. With the composite FK added by this
  -- migration, a row whose restaurant_id disagrees with its batch's can
  -- no longer exist in the first place, so this is defense in depth: it
  -- turns what would otherwise be a silent "processed zero rows" no-op
  -- for a non-member's batch id into an explicit, actionable error.
  if not exists (select 1 from public.import_batches where id = p_batch_id) then
    raise exception 'import batch % not found', p_batch_id using errcode = 'P0002';
  end if;

  for v_row in
    select r.*
    from public.import_batch_rows r
    where r.batch_id = p_batch_id
      and r.apply_status = 'not_applied'
      and r.row_state = 'valid'
      and r.resolution in ('auto', 'include')
    order by r.row_number
    limit least(greatest(p_limit, 1), 500)
    for update skip locked
  loop
    begin
      if v_row.cost_status = 'missing' then
        if v_row.manual_unit_cost is null then
          row_id := v_row.id;
          row_number := v_row.row_number;
          outcome := 'blocked';
          inventory_item_id := null;
          error_message := 'Missing unit cost has no operator-provided value.';
          return next;
          continue;
        end if;
        v_unit_cost := v_row.manual_unit_cost;
      else
        v_unit_cost := nullif(v_row.raw ->> 'unit_cost', '')::numeric(10,2);
      end if;

      if v_unit_cost is null then
        row_id := v_row.id;
        row_number := v_row.row_number;
        outcome := 'blocked';
        inventory_item_id := null;
        error_message := 'Row has no usable unit cost.';
        return next;
        continue;
      end if;

      -- Same dedup key as find_or_create_wines_batch (0006): reuse the
      -- existing wine if this restaurant already has one, fill in only
      -- the fields that were previously null, never overwrite.
      insert into public.wines (
        restaurant_id, name, producer, vintage, varietal, region, country, size_ml, lwin_id
      ) values (
        v_row.restaurant_id,
        v_row.raw ->> 'name',
        v_row.raw ->> 'producer',
        nullif(v_row.raw ->> 'vintage', '')::int,
        nullif(v_row.raw ->> 'varietal', ''),
        nullif(v_row.raw ->> 'region', ''),
        nullif(v_row.raw ->> 'country', ''),
        coalesce(nullif(v_row.raw ->> 'size_ml', '')::int, 750),
        v_row.lwin_id
      )
      on conflict (restaurant_id, lower(producer), lower(name), coalesce(vintage, 0), size_ml)
      do update set
        varietal = coalesce(public.wines.varietal, excluded.varietal),
        region   = coalesce(public.wines.region, excluded.region),
        country  = coalesce(public.wines.country, excluded.country),
        lwin_id  = coalesce(public.wines.lwin_id, excluded.lwin_id)
      returning id into v_wine_id;

      -- Defensive: an INSERT/ON-CONFLICT-DO-UPDATE...RETURNING that
      -- somehow yields no row must never silently fall through to
      -- marking this row applied with a dangling reference — fail this
      -- row loudly (caught below, retried on the next apply call)
      -- instead.
      if v_wine_id is null then
        raise exception 'wine insert/lookup returned no row for import_batch_row %', v_row.id;
      end if;

      -- C11 (db audit 2026-08-23): resolve an existing bins row by the
      -- same case-insensitive/btrim-normalized code the operator already
      -- uses (bins_restaurant_code_idx is itself a unique lower(code)
      -- index, so this can match at most one row). Does NOT create a
      -- missing bin — see migration header.
      v_bin_id := null;
      if nullif(v_row.raw ->> 'bin', '') is not null then
        select id into v_bin_id
          from public.bins
          where restaurant_id = v_row.restaurant_id
            and lower(code) = lower(btrim(v_row.raw ->> 'bin'))
          limit 1;
      end if;

      insert into public.inventory_items (
        wine_id, restaurant_id, quantity, unit_cost, bin_location, bin_id, section, format, currency, added_via
      ) values (
        v_wine_id,
        v_row.restaurant_id,
        coalesce(nullif(v_row.raw ->> 'quantity', '')::int, 0),
        v_unit_cost,
        nullif(v_row.raw ->> 'bin', ''),
        v_bin_id,
        nullif(v_row.raw ->> 'section', ''),
        nullif(v_row.raw ->> 'format', ''),
        nullif(v_row.raw ->> 'currency', ''),
        'manual'
      )
      returning id into v_inventory_id;

      if v_inventory_id is null then
        raise exception 'inventory_items insert returned no row for import_batch_row %', v_row.id;
      end if;

      update public.import_batch_rows
      set apply_status = 'applied',
          applied_inventory_item_id = v_inventory_id,
          applied_wine_id = v_wine_id,
          updated_at = now()
      where id = v_row.id;

      row_id := v_row.id;
      row_number := v_row.row_number;
      outcome := 'applied';
      inventory_item_id := v_inventory_id;
      error_message := null;
      return next;
    exception when others then
      -- Caught per-row (an implicit savepoint) so one bad row can never
      -- take the rest of the chunk down with it. The row stays
      -- 'not_applied' and is retried on the next apply call.
      row_id := v_row.id;
      row_number := v_row.row_number;
      outcome := 'error';
      inventory_item_id := null;
      error_message := sqlerrm;
      return next;
    end;
  end loop;
end;
$$;

comment on function public.apply_import_batch_chunk(uuid, integer) is
  'Applies up to p_limit not-yet-applied, eligible rows of one import '
  'batch. C17 (db audit 2026-08-23): re-validates the batch itself is '
  'visible (member of its restaurant) before processing any rows. C11 '
  '(db audit 2026-08-23): resolves inventory_items.bin_id from an '
  'existing bins row matching the CSV bin code, so imported stock is not '
  'universally treated as unplaced. FOR UPDATE SKIP LOCKED means '
  'concurrent/duplicate calls for the same batch never double-apply a '
  'row. Each row''s wine-lookup + inventory-insert + row-status-update is '
  'wrapped in its own exception block, so a single row failing never '
  'blocks or half-applies the others — call again to retry whatever '
  'remains not_applied. SECURITY INVOKER: RLS on '
  'import_batch_rows/wines/inventory_items is the tenant boundary, so a '
  'batch id from another restaurant is simply invisible to the initial '
  'SELECT and the loop does nothing.';

revoke all on function public.apply_import_batch_chunk(uuid, integer) from public;
grant execute on function public.apply_import_batch_chunk(uuid, integer) to authenticated;
