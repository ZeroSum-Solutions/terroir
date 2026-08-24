-- 0082_import_batch_rows_tenant_fk.sql
--
-- C17 (db audit 2026-08-23) — import_batch_rows.batch_id and .restaurant_id
-- are two INDEPENDENT foreign keys (batch_id -> import_batches(id),
-- restaurant_id -> restaurants(id)) with no relationship enforced between
-- them. The INSERT policy validates only the row's own restaurant_id
-- (`is_member_with_role(restaurant_id, 'staff')`), never that batch_id
-- actually belongs to that restaurant.
--
-- Verified (.../scratchpad/db-audit/verify/V1-tenancy.md, C17), practical
-- blast radius corrected from the original claim: this is a DoS on a
-- VICTIM's own bulk-import confirm step, reachable by ANY authenticated
-- user with ZERO membership in the victim tenant — not only a dual-
-- membership scenario. ownerB (no membership in restaurant A) inserted a
-- row into A's real batch tagged with B's OWN restaurant_id at
-- row_number = 1 (201 Created — RLS only checked restaurant_id = B, which
-- passed for B). ownerA's subsequent real CSV-confirm insert (their own
-- rows 1-3) then failed outright: 409 Conflict, 23505 unique violation on
-- `import_batch_rows_batch_id_row_number_key`, because a stranger had
-- already occupied row_number = 1 in A's batch. batch_id is not a secret —
-- it's returned directly on batch creation and visible in any browser
-- network tab during the real confirm flow — so this needs no privileged
-- access, only observing or guessing a UUID. Separately, ownerB could call
-- apply_import_batch_chunk('<A_batch>') and have it process B's own
-- poison row as a "borrowed" container, even though the resulting write
-- still landed correctly under B (apply_import_batch_chunk is SECURITY
-- INVOKER, so RLS still scoped that specific write to B).
--
-- Fix, per the fix sketch:
--   1. UNIQUE (id, restaurant_id) on import_batches (id is already the
--      primary key, so this restricts nothing new — it exists purely to
--      be a composite FK target).
--   2. Replace import_batch_rows' two independent FKs
--      (import_batch_rows_batch_id_fkey, import_batch_rows_restaurant_id_fkey)
--      with ONE composite FK: (batch_id, restaurant_id) REFERENCES
--      import_batches (id, restaurant_id). This makes "this row's
--      restaurant_id equals its batch's real restaurant_id" a hard schema
--      invariant, independent of RLS — the exact poison-row insert the
--      verifier ran (batch_id = A's batch, restaurant_id = B) can no
--      longer succeed: (A_batch_id, B) does not exist as a pair in
--      import_batches, because import_batches' own row for A_batch has
--      restaurant_id = A. restaurant_id's referential integrity (must be
--      a real restaurants.id) is preserved transitively — import_batches
--      itself keeps its own restaurant_id -> restaurants(id) FK, unchanged.
--   3. apply_import_batch_chunk re-validates the batch's own tenant before
--      processing (belt-and-suspenders — with the composite FK in place, a
--      poison row across tenants can no longer exist, so this mainly turns
--      a silent "processed zero rows" no-op for a non-member's batch id
--      into an explicit, actionable error). Uses the exact same "RLS
--      already filtered this to batches I'm a member of — a cross-tenant
--      id is indistinguishable from a nonexistent one" idiom
--      revert_import_batch (0076) already established for this table.
--
-- If any existing row in import_batch_rows already violates the new
-- invariant (its restaurant_id disagrees with its batch's), the ADD
-- CONSTRAINT step below fails loudly — that is the intended behavior: it
-- means a real data-integrity problem exists and must be investigated
-- before the schema can safely lock it down, not something this migration
-- should silently paper over.
--
-- Lock note: import_batches/import_batch_rows are expected to be small
-- (bulk-import metadata, not the 20k-row inventory itself) at this stage —
-- the ADD CONSTRAINT here takes a brief ACCESS EXCLUSIVE lock for a
-- full-table validation scan, acceptable at current scale. If either table
-- grows materially, add the FK as NOT VALID + a separate VALIDATE
-- CONSTRAINT step instead.
--
-- DOWN: drops the composite FK and the import_batches uniqueness
-- constraint, restores the two independent FKs, and restores
-- apply_import_batch_chunk's pre-fix body. See
-- down/0082_import_batch_rows_tenant_fk.down.sql.

-- ── 1. import_batches(id, restaurant_id) — composite FK target ─────────
alter table public.import_batches
  add constraint import_batches_id_restaurant_id_key unique (id, restaurant_id);

-- ── 2. import_batch_rows: one composite FK instead of two independent ──
alter table public.import_batch_rows
  drop constraint import_batch_rows_batch_id_fkey,
  drop constraint import_batch_rows_restaurant_id_fkey,
  add constraint import_batch_rows_batch_restaurant_fkey
    foreign key (batch_id, restaurant_id)
    references public.import_batches (id, restaurant_id)
    on delete cascade;

comment on constraint import_batch_rows_batch_restaurant_fkey on public.import_batch_rows is
  'C17 (db audit 2026-08-23): replaces the old independent batch_id/'
  'restaurant_id FKs. Forces every row''s restaurant_id to match its '
  'batch''s real restaurant_id — a cross-tenant "poison row" (real batch, '
  'wrong tenant) can no longer be inserted, regardless of RLS.';

-- ── 3. apply_import_batch_chunk: re-validate the batch's own tenant ────
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

      insert into public.inventory_items (
        wine_id, restaurant_id, quantity, unit_cost, bin_location, section, format, currency, added_via
      ) values (
        v_wine_id,
        v_row.restaurant_id,
        coalesce(nullif(v_row.raw ->> 'quantity', '')::int, 0),
        v_unit_cost,
        nullif(v_row.raw ->> 'bin', ''),
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
  'visible (member of its restaurant) before processing any rows. FOR '
  'UPDATE SKIP LOCKED means concurrent/duplicate calls for the same batch '
  'never double-apply a row. Each row''s wine-lookup + inventory-insert + '
  'row-status-update is wrapped in its own exception block, so a single '
  'row failing never blocks or half-applies the others — call again to '
  'retry whatever remains not_applied. SECURITY INVOKER: RLS on '
  'import_batch_rows/wines/inventory_items is the tenant boundary, so a '
  'batch id from another restaurant is simply invisible to the initial '
  'SELECT and the loop does nothing.';

revoke all on function public.apply_import_batch_chunk(uuid, integer) from public;
grant execute on function public.apply_import_batch_chunk(uuid, integer) to authenticated;
