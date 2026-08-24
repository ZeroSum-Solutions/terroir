-- 0108_apply_import_batch_chunk_v2.sql
--
-- P3 §5 — three fixes to apply_import_batch_chunk (0076, C11-fixed in
-- 0085, C17-fixed in 0082), `create or replace`d in place. The function
-- KEEPS its original name — not renamed to a distinct "_v2" function —
-- for the same reason 0082 and 0085 both replaced it in place rather than
-- introducing a second implementation: exactly one "apply a chunk of this
-- batch" entry point must exist, or the app's own two-path resumability
-- story (safe to call again after a timeout/crash) becomes a question of
-- WHICH version got called, not just whether it was called again. The
-- design doc's own §4 table literally says "create or replace" for this
-- migration despite naming the FILE apply_import_batch_chunk_v2.sql — the
-- "_v2" is a label for this round of changes, not a second function.
--
-- Fix 1 (C03, second half): C03's countBatchRows half is fixed by
-- count_import_batch_rows (0106); the OTHER half of C03 is that this
-- function itself never checked import_batches.status at all before
-- processing rows — so a batch flipped to 'reverted' by revert_import_
-- batch could still be re-applied into, because revert only ever flips
-- APPLIED rows to apply_status = 'reverted'; a not-yet-applied row in a
-- reverted batch stays 'not_applied' and still satisfies this function's
-- eligibility WHERE clause. Fix: lock and check import_batches.status
-- FIRST; no-op (return zero rows) when status = 'reverted'.
--
-- Fix 2 (C16): a permanently-failing row (e.g. numeric field overflow) was
-- re-selected by every future call forever — same LIMIT window, no state
-- change on error — starving every eligible row behind it, with the
-- failure never persisted anywhere. Fix: track apply_attempts/
-- last_error_message (0104) in the exception handler; on the
-- MAX_ROW_APPLY_ATTEMPTSth failure (3 — matches src/domains/import/
-- constants.ts MAX_ROW_APPLY_ATTEMPTS), flip resolution to 'pending'
-- (existing enum value) so the row falls out of the eligibility WHERE
-- clause automatically. Deliberately scoped to the exception handler only
-- (not the pre-existing 'blocked' branch for missing-cost rows) — that
-- branch is unreachable via the app's own resolveImportBatchRow flow
-- today (include with cost_status = 'missing' always requires and sets
-- manual_unit_cost), so it carries no live starvation risk to fix.
--
-- Fix 3 (C24): the wines upsert's `coalesce(wines.lwin_id, excluded.
-- lwin_id)` locked in whichever match arrived FIRST, permanently — even a
-- 0.95-confidence match landing after a 0.31-confidence one for the same
-- wine identity in the same import. Fix: (a) only forward a match into
-- wines.lwin_id/lwin_match_score when it clears LWIN_APPLY_MIN_SCORE
-- (0.6 — P2's own stated confidence bar, §6 of the P2 design; match_lwin's
-- own 0.3 threshold stays a preview-time "worth showing as a candidate"
-- bar, deliberately more permissive); (b) the upsert now prefers whichever
-- match scored HIGHER, in either arrival order, using the new
-- wines.lwin_match_score (0105) to compare.
--
-- DOWN: restores this function to its exact pre-P3 (0085) body — see
-- down/0108_apply_import_batch_chunk_v2.down.sql.

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
  v_batch_status text;
  v_lwin_id text;
  v_lwin_score real;
  v_attempts int;
begin
  -- C03 (second half): lock the batch row and check its status BEFORE
  -- touching any import_batch_rows. Replaces 0082/0085's plain
  -- `if not exists (...)` visibility check with a `for update`-locked
  -- status read — still gives C17's original re-validation-of-tenant
  -- guarantee (RLS on import_batches makes a foreign batch id invisible,
  -- so `not found` fires identically for "doesn't exist" and "not mine"),
  -- and additionally makes a reverted batch a hard no-op.
  select status into v_batch_status
    from public.import_batches
    where id = p_batch_id
    for update;

  if not found then
    raise exception 'import batch % not found', p_batch_id using errcode = 'P0002';
  end if;

  if v_batch_status = 'reverted' then
    return; -- no-op: a reverted batch can never be re-applied into.
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

      -- C24: only forward a LWIN match into wines.lwin_id when it clears
      -- the apply-time confidence bar (0.6) — match_lwin's own 0.3
      -- threshold exists to surface preview candidates, not to gate a
      -- persisted, hard-to-undo catalog link. Below the bar this row
      -- behaves exactly like it had no LWIN match at all.
      if v_row.lwin_score is not null and v_row.lwin_score >= 0.6 then
        v_lwin_id := v_row.lwin_id;
        v_lwin_score := v_row.lwin_score;
      else
        v_lwin_id := null;
        v_lwin_score := null;
      end if;

      -- Same dedup key as find_or_create_wines_batch (0006): reuse the
      -- existing wine if this restaurant already has one, fill in only
      -- the fields that were previously null, never overwrite — except
      -- lwin_id/lwin_match_score (C24), which now prefer whichever match
      -- scored higher regardless of insertion order: a later
      -- higher-confidence match can overwrite an earlier lower-confidence
      -- one, but a later LOWER-confidence match can never downgrade a
      -- higher-confidence one already in place. A wine whose lwin_id was
      -- set by some OTHER path (e.g. match_lwin_batch, 0007) has
      -- lwin_match_score = null; the `wines.lwin_id is null` branch of
      -- the CASE is the only way to overwrite that, matching the pre-C24
      -- coalesce's own behavior for that case exactly (never overwrite a
      -- non-null lwin_id it can't compare a score against).
      insert into public.wines (
        restaurant_id, name, producer, vintage, varietal, region, country, size_ml,
        lwin_id, lwin_match_score
      ) values (
        v_row.restaurant_id,
        v_row.raw ->> 'name',
        v_row.raw ->> 'producer',
        nullif(v_row.raw ->> 'vintage', '')::int,
        nullif(v_row.raw ->> 'varietal', ''),
        nullif(v_row.raw ->> 'region', ''),
        nullif(v_row.raw ->> 'country', ''),
        coalesce(nullif(v_row.raw ->> 'size_ml', '')::int, 750),
        v_lwin_id,
        v_lwin_score
      )
      on conflict (restaurant_id, lower(producer), lower(name), coalesce(vintage, 0), size_ml)
      do update set
        varietal = coalesce(public.wines.varietal, excluded.varietal),
        region   = coalesce(public.wines.region, excluded.region),
        country  = coalesce(public.wines.country, excluded.country),
        lwin_id = case
          when excluded.lwin_id is not null
            and (public.wines.lwin_id is null or excluded.lwin_match_score > public.wines.lwin_match_score)
          then excluded.lwin_id
          else public.wines.lwin_id
        end,
        lwin_match_score = case
          when excluded.lwin_id is not null
            and (public.wines.lwin_id is null or excluded.lwin_match_score > public.wines.lwin_match_score)
          then excluded.lwin_match_score
          else public.wines.lwin_match_score
        end
      returning id into v_wine_id;

      if v_wine_id is null then
        raise exception 'wine insert/lookup returned no row for import_batch_row %', v_row.id;
      end if;

      -- C11 (0085, unchanged): resolve an existing bins row by the same
      -- case-insensitive/btrim-normalized code the operator already uses.
      -- Does NOT create a missing bin — see 0085's header.
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
      -- C16: track attempts. On the 3rd failure, flip resolution to
      -- 'pending' so this row falls out of the eligibility WHERE clause
      -- above automatically (no index change needed — the existing
      -- eligibility index already filters on resolution) instead of being
      -- re-selected by every future call forever and starving every
      -- eligible row behind it. Surfaces through the same pending-row UI/
      -- resolveImportBatchRow path §1.5 tier 3 already uses, distinguished
      -- by last_error_message is not null.
      v_attempts := v_row.apply_attempts + 1;
      update public.import_batch_rows
      set apply_attempts = v_attempts,
          last_error_message = sqlerrm,
          resolution = case when v_attempts >= 3 then 'pending' else resolution end,
          updated_at = now()
      where id = v_row.id;

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
  'batch. C03 (db audit 2026-08-23): locks and checks import_batches.'
  'status first — a reverted batch is a hard no-op, it can never be '
  're-applied into. C16: tracks apply_attempts/last_error_message per row; '
  'a row failing 3 times moves to resolution = pending instead of '
  'starving every eligible row behind it forever. C24: only forwards a '
  'LWIN match into wines.lwin_id at score >= 0.6, and prefers whichever '
  'match scored higher regardless of arrival order. C11 (0085, unchanged): '
  'resolves inventory_items.bin_id from an existing bins row matching the '
  'CSV bin code. FOR UPDATE SKIP LOCKED means concurrent/duplicate calls '
  'for the same batch never double-apply a row. SECURITY INVOKER: RLS on '
  'import_batches/import_batch_rows/wines/inventory_items is the tenant '
  'boundary.';

revoke all on function public.apply_import_batch_chunk(uuid, integer) from public;
grant execute on function public.apply_import_batch_chunk(uuid, integer) to authenticated;
