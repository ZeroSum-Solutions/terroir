-- 0076_csv_import_batches.sql
--
-- G1-4: bulk cellar onboarding via CSV import.
--
-- Two new tables carry the durable state a resumable, reversible import
-- needs — batch-level accounting (import_batches) and row-level state
-- (import_batch_rows), per the plan bar: "row-level atomicity with
-- batch-level accounting, not one giant transaction that can time out on
-- big files." Every row a CSV produces gets exactly one
-- import_batch_rows record the moment the batch is confirmed (a single
-- multi-row INSERT — atomic on its own, no PL/pgSQL loop needed for
-- that part). Applying a batch then walks its rows in bounded chunks
-- (apply_import_batch_chunk), each row's wine-lookup + inventory-insert +
-- row-status-update wrapped in its own PL/pgSQL exception block so one
-- bad row can never abort the rest of the chunk, and a row already
-- applied is simply skipped by the eligibility WHERE clause — safe to
-- call apply_import_batch_chunk again after a timeout, a crash, or a
-- deliberate pause with zero risk of double-applying or half-writing a
-- row.
--
-- No background_jobs / worker involvement (see docs/runbooks/
-- csv-import.md for the documented threshold and the decision not to
-- wire the G1-6 runner here): the Railway worker service is not deployed
-- anywhere yet, and chunked synchronous apply calls, each bounded to a
-- handful of rows, comfortably cover the realistic size of a
-- restaurant's existing cellar (hundreds to low thousands of SKUs) —
-- there is no route handler in this migration's feature that risks a
-- platform timeout in the first place, so trading that away for a
-- from-scratch dependency on an undeployed worker is not a good trade
-- today.
--
-- Authorization model: every function here is SECURITY INVOKER (the
-- default) and granted to `authenticated`, not `service_role`. Unlike
-- G1-6's runner (a trusted background process using the service role,
-- which bypasses RLS entirely), these functions run as whichever member
-- calls them — so table RLS (added below) is the actual tenant boundary,
-- the same trust model as every other member-facing mutation in this
-- app (see stock_adjustments, background_jobs). A cross-tenant call
-- fails closed: the initial row lookup inside each function is itself
-- RLS-filtered, so a batch id belonging to another restaurant is simply
-- invisible, not merely "rejected after being read."
--
-- added_via is deliberately left alone. CSV-imported inventory rows keep
-- added_via = 'manual' rather than adding a new enum value — Postgres
-- enum types cannot drop a value, which is exactly what made G1-6's
-- first attempt at a down migration fail (rows already using the new
-- job_type/status vocabulary couldn't exist under the constraints being
-- restored). Provenance here is tracked precisely by
-- import_batch_rows.applied_inventory_item_id (which batch AND which row
-- created a given inventory row) — strictly more informative than a
-- coarse enum tag, and it keeps this migration's down path a plain
-- DROP TABLE with no destructive row surgery required.

-- ── 1. import_batches ───────────────────────────────────────────────────
create table public.import_batches (
  id             uuid        primary key default gen_random_uuid(),
  restaurant_id  uuid        not null references public.restaurants(id) on delete cascade,
  created_by     uuid        references auth.users(id) on delete set null,
  filename       text        not null,
  status         text        not null default 'created' check (
    status in ('created', 'applying', 'completed', 'reverted')
  ),
  total_rows     integer     not null check (total_rows >= 0),
  reverted_at    timestamptz,
  reverted_by    uuid        references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table public.import_batches is
  'One row per confirmed CSV cellar import. Row-level detail (validation, '
  'LWIN match, apply/revert state) lives in import_batch_rows — this table '
  'is batch-level accounting only. status is a convenience projection the '
  'API recomputes from import_batch_rows after every apply/resolve call, '
  'not an independent source of truth.';

comment on column public.import_batches.status is
  'created: rows persisted, apply not yet run (or not yet finished — see '
  'applying). applying: at least one apply chunk has run but eligible '
  'rows remain, or unresolved rows are still pending operator action. '
  'completed: every row has a final fate (applied, system/operator-'
  'excluded) and nothing is pending. reverted: a completed batch was '
  'rolled back — see revert_import_batch.';

create index import_batches_restaurant_idx
  on public.import_batches (restaurant_id, created_at desc);

create trigger import_batches_set_updated_at
  before update on public.import_batches
  for each row execute function public.set_updated_at();

alter table public.import_batches enable row level security;

create policy "members can read import batches"
  on public.import_batches for select
  using (public.is_member(restaurant_id));

create policy "members can create own import batches"
  on public.import_batches for insert
  with check (
    public.is_member_with_role(restaurant_id, 'staff')
    and created_by = auth.uid()
  );

-- Needed for the API's status recompute after apply/resolve calls, and
-- for revert_import_batch's own status transition. No delete policy —
-- a batch is never removed, only reverted (status transition, audit
-- trail preserved).
create policy "members can update own import batches"
  on public.import_batches for update
  using      (public.is_member_with_role(restaurant_id, 'staff'))
  with check (public.is_member_with_role(restaurant_id, 'staff'));

-- 0074 granted table DML to `authenticated` once, for the tables that
-- existed at the time, and only extended ALTER DEFAULT PRIVILEGES going
-- forward for `service_role` — not `authenticated`. A brand new table
-- like this one therefore starts with NO base table privilege for
-- `authenticated` at all (RLS policies alone are not enough; Postgres
-- checks the base GRANT first). Every table this migration adds needs
-- this explicit grant, or every policy above is unreachable.
grant select, insert, update on table public.import_batches to authenticated;
-- No delete policy exists (batches are a permanent audit trail) —
-- explicitly withhold DELETE too, the same belt-and-suspenders the
-- immutable stock_adjustments table (0063) uses.
revoke delete on table public.import_batches from authenticated;

-- ── 2. import_batch_rows ─────────────────────────────────────────────────
create table public.import_batch_rows (
  id                        uuid        primary key default gen_random_uuid(),
  batch_id                  uuid        not null references public.import_batches(id) on delete cascade,
  restaurant_id             uuid        not null references public.restaurants(id) on delete cascade,
  row_number                integer     not null check (row_number > 0),
  raw                       jsonb       not null,
  row_state                 text        not null check (row_state in ('valid', 'error')),
  validation_errors         jsonb       not null default '[]'::jsonb,
  lwin_status               text        not null default 'unmatched' check (
    lwin_status in ('matched', 'unmatched')
  ),
  lwin_id                   text,
  lwin_score                real,
  cost_status               text        not null default 'present' check (
    cost_status in ('present', 'missing')
  ),
  resolution                text        not null default 'auto' check (
    resolution in ('auto', 'pending', 'include', 'exclude')
  ),
  manual_unit_cost          numeric(10,2) check (manual_unit_cost is null or manual_unit_cost >= 0),
  apply_status              text        not null default 'not_applied' check (
    apply_status in ('not_applied', 'applied', 'reverted')
  ),
  applied_inventory_item_id uuid        references public.inventory_items(id) on delete set null,
  applied_wine_id           uuid        references public.wines(id) on delete set null,
  resolved_at               timestamptz,
  resolved_by               uuid        references auth.users(id) on delete set null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (batch_id, row_number),
  -- A row that failed schema validation can never be applied — it is
  -- permanently system-excluded, not something the operator resolves
  -- via a manual-cost or include/exclude action (fixing it means
  -- correcting the source CSV and re-importing).
  constraint import_batch_rows_error_excluded
    check (row_state <> 'error' or resolution = 'exclude'),
  -- An 'applied' row must always carry the id of the inventory row it
  -- created — that id is what revert_import_batch deletes, and this
  -- constraint guarantees revert can never lose track of it.
  constraint import_batch_rows_applied_has_inventory_id
    check (apply_status <> 'applied' or applied_inventory_item_id is not null)
);

comment on table public.import_batch_rows is
  'One row per CSV data row in a confirmed import batch. raw holds the '
  'parsed (formula-neutralized) cell values keyed by canonical field name '
  '(producer, name, vintage, varietal, region, country, size_ml, format, '
  'currency, quantity, unit_cost, bin, section) — the same shape the '
  'preview endpoint computes, so confirm never trusts a client-supplied '
  'preview payload, it re-derives everything from the uploaded file.';

comment on column public.import_batch_rows.resolution is
  'auto: valid, LWIN-matched (or catalog match not required), cost '
  'present — applies with no operator action. pending: unmatched LWIN '
  'and/or missing cost — held out of apply until the operator resolves '
  'it. include: operator resolved a pending row to proceed anyway '
  '(unmatched rows are created as new, unlinked wines — never silently '
  'fuzzy-merged into a low-confidence LWIN guess). exclude: system '
  '(error rows) or operator decision to leave the row out of inventory '
  'permanently.';

comment on column public.import_batch_rows.apply_status is
  'not_applied: not yet written to inventory (either not eligible yet, '
  'or eligible but not yet processed by an apply chunk — safe to retry). '
  'applied: inventory_items row created; applied_inventory_item_id names '
  'it. reverted: was applied, then removed by revert_import_batch.';

create index import_batch_rows_restaurant_idx
  on public.import_batch_rows (restaurant_id);

-- Matches apply_import_batch_chunk's eligibility WHERE clause exactly,
-- so a chunk call on a large batch doesn't degrade to a sequential scan
-- once most rows are already applied.
create index import_batch_rows_apply_eligible_idx
  on public.import_batch_rows (batch_id, row_number)
  where apply_status = 'not_applied' and row_state = 'valid'
    and resolution in ('auto', 'include');

-- The operator-facing "needs resolution" bucket (LWIN-unmatched and/or
-- missing-cost rows nobody has decided on yet).
create index import_batch_rows_pending_idx
  on public.import_batch_rows (batch_id)
  where resolution = 'pending';

create trigger import_batch_rows_set_updated_at
  before update on public.import_batch_rows
  for each row execute function public.set_updated_at();

alter table public.import_batch_rows enable row level security;

create policy "members can read import batch rows"
  on public.import_batch_rows for select
  using (public.is_member(restaurant_id));

create policy "members can create import batch rows"
  on public.import_batch_rows for insert
  with check (public.is_member_with_role(restaurant_id, 'staff'));

-- No delete policy — rows are a permanent audit trail, including after
-- revert (apply_status flips to 'reverted', the row itself stays).
create policy "members can update import batch rows"
  on public.import_batch_rows for update
  using      (public.is_member_with_role(restaurant_id, 'staff'))
  with check (public.is_member_with_role(restaurant_id, 'staff'));

grant select, insert, update on table public.import_batch_rows to authenticated;
revoke delete on table public.import_batch_rows from authenticated;

-- ── 3. match_lwin_bulk — one-round-trip LWIN preview matching ───────────
-- Preview must do zero database writes but still resolve LWIN match
-- status for every row in one request. Calling match_lwin (0007) once
-- per row from the API would mean one RPC round trip per CSV row; this
-- wraps it in a single set-returning call instead, reusing match_lwin's
-- existing trigram-similarity logic rather than forking it. idx lets the
-- caller zip results back onto its input array (LEFT JOIN LATERAL keeps
-- unmatched queries in the output as null-lwin_id rows instead of
-- dropping them).
create or replace function public.match_lwin_bulk(p_queries jsonb, p_threshold float default 0.3)
returns table (
  idx          integer,
  lwin_id      text,
  display_name text,
  producer     text,
  varietal     text,
  region       text,
  country      text,
  colour       text,
  score        float
)
language sql
stable
security invoker
set search_path = public
as $$
  select q.idx, m.lwin_id, m.display_name, m.producer, m.varietal,
         m.region, m.country, m.colour, m.score
  from jsonb_to_recordset(p_queries) as q(idx integer, producer text, name text)
  left join lateral public.match_lwin(q.producer, q.name, p_threshold) m on true;
$$;

comment on function public.match_lwin_bulk(jsonb, float) is
  'Read-only bulk wrapper around match_lwin (0007) for CSV import preview '
  '— p_queries is a jsonb array of {idx, producer, name}. SECURITY '
  'INVOKER: it performs no writes and match_lwin (SECURITY DEFINER) '
  'already handles the lwin_catalog read, so no elevated privilege is '
  'needed here.';

revoke all on function public.match_lwin_bulk(jsonb, float) from public;
grant execute on function public.match_lwin_bulk(jsonb, float) to authenticated;

-- ── 4. apply_import_batch_chunk — bounded, resumable, row-atomic apply ──
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
  'batch. FOR UPDATE SKIP LOCKED means concurrent/duplicate calls for '
  'the same batch never double-apply a row. Each row''s wine-lookup + '
  'inventory-insert + row-status-update is wrapped in its own exception '
  'block, so a single row failing never blocks or half-applies the '
  'others — call again to retry whatever remains not_applied. SECURITY '
  'INVOKER: RLS on import_batch_rows/wines/inventory_items is the '
  'tenant boundary, so a batch id from another restaurant is simply '
  'invisible to the initial SELECT and the loop does nothing.';

revoke all on function public.apply_import_batch_chunk(uuid, integer) from public;
grant execute on function public.apply_import_batch_chunk(uuid, integer) to authenticated;

-- ── 5. revert_import_batch — undo exactly what one batch created ────────
create or replace function public.revert_import_batch(p_batch_id uuid)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_restaurant_id uuid;
  v_status text;
  v_row record;
  v_count integer := 0;
begin
  select restaurant_id, status into v_restaurant_id, v_status
  from public.import_batches
  where id = p_batch_id
  for update;

  if not found then
    -- RLS already filtered this to "batches I'm a member of" — a
    -- cross-tenant batch id lands here indistinguishable from a
    -- nonexistent one, which is the point.
    raise exception 'import batch % not found', p_batch_id using errcode = 'P0002';
  end if;

  if v_status <> 'completed' then
    raise exception 'import batch % is not completed (status=%)', p_batch_id, v_status
      using errcode = 'P0001';
  end if;

  for v_row in
    select id, applied_inventory_item_id
    from public.import_batch_rows
    where batch_id = p_batch_id and apply_status = 'applied'
    for update
  loop
    -- Order matters here. import_batch_rows_applied_has_inventory_id
    -- (0076) requires applied_inventory_item_id IS NOT NULL whenever
    -- apply_status = 'applied'. applied_inventory_item_id references
    -- inventory_items ON DELETE SET NULL, so deleting the inventory row
    -- FIRST fires that FK action immediately — nulling the column while
    -- apply_status here is STILL 'applied' — and violates the very
    -- constraint that's supposed to prevent this state. Flipping
    -- apply_status to 'reverted' (and nulling the column ourselves)
    -- first means the constraint's exception is already satisfied
    -- before the delete's FK action can touch the row at all.
    update public.import_batch_rows
    set apply_status = 'reverted',
        applied_inventory_item_id = null,
        updated_at = now()
    where id = v_row.id;

    -- Deletes only the inventory_items row THIS row created — never
    -- touches any other row, including pre-existing inventory for the
    -- same wine or same restaurant.
    delete from public.inventory_items
    where id = v_row.applied_inventory_item_id
      and restaurant_id = v_restaurant_id;

    v_count := v_count + 1;
  end loop;

  update public.import_batches
  set status = 'reverted', reverted_at = now(), reverted_by = auth.uid()
  where id = p_batch_id;

  return v_count;
end;
$$;

comment on function public.revert_import_batch(uuid) is
  'Reverts one completed batch: deletes exactly the inventory_items rows '
  'recorded in applied_inventory_item_id for this batch''s applied rows '
  '(never wines, never another batch''s or another source''s inventory '
  'rows), flips those rows to reverted, and the batch to reverted. Only '
  'callable on a batch in status = completed. Returns the count of rows '
  'reverted. reverted_by is auth.uid() — the invoking session''s own '
  'identity, never a client-supplied value.';

revoke all on function public.revert_import_batch(uuid) from public;
grant execute on function public.revert_import_batch(uuid) to authenticated;
