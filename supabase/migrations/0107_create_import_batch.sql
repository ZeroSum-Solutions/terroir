-- 0107_create_import_batch.sql
--
-- P3 §5 (C09) + §1.5 (tier 2 duplicate surfacing) + §2.2/§3.2 (re-upload
-- idempotency, session grouping).
--
-- C09, restated: confirmImportBatch's batch-insert and rows-insert were
-- two SEPARATE client-side statements. A rows-insert failure (any CHECK/
-- FK violation across up to 5,000 rows) left an orphaned, empty
-- import_batches row behind — REVOKEd DELETE (0076) means the app can't
-- clean it up, and it later self-reports status = 'completed' (a vacuous
-- truth: 0 of 0 rows "complete", see deriveBatchStatus). Fire the exact
-- same confirm twice with byte-identical content and, pre-P3, you'd get
-- TWO such batches, and applying both doubles every quantity on every
-- wine in the file.
--
-- Fix: one SECURITY INVOKER PL/pgSQL function wrapping the batch insert
-- and the rows insert in its own implicit transaction. If the rows insert
-- fails (or a duplicate content_sha256/session+chunk_index hits the
-- partial unique indexes from 0103, raising 23505), Postgres rolls back
-- the WHOLE function call automatically — there is never a batch row
-- without its rows, and the REVOKEd DELETE grant becomes irrelevant
-- (nothing needs deleting). confirmImportBatch (src/domains/import/
-- batch-service.ts) changes from two separate .insert() calls to one
-- supabase.rpc('create_import_batch', {...}) call; on a 23505 it looks up
-- and returns the pre-existing batch's id/status/counts as a resume
-- pointer instead of a bare rejection (§2.2) — that lookup is a plain
-- SELECT done in TypeScript, not inside this function, so this function's
-- only job on conflict is to raise, cleanly, and roll back everything.
--
-- Tier 2 duplicate surfacing (§1.5): once rows are inserted, two set-based
-- UPDATEs (not a per-row loop — see comments inline) flag any row whose
-- resolved wine identity + normalized (bin, section) already has (a) an
-- APPLIED inventory_items row from a different, already-confirmed batch
-- (any session, including pre-existing manual inventory), or (b) when
-- p_session_id is given, a NOT-YET-APPLIED row in a sibling batch of the
-- SAME session (closes the TOCTOU gap in §3.3: five chunks may all be
-- confirmed before any of them is applied, so (a) alone would miss a wine
-- appearing in both chunk 1 and chunk 4). Flagged rows get
-- resolution = 'pending' + duplicate_reason populated — never silently
-- merged, because a merged row would break revert_import_batch's
-- one-row-per-batch traceability contract (§1.5's own reasoning, restated
-- in 0104's column comment).
--
-- Wine-identity key used by both checks is the SAME fallback four-tuple
-- wines_dedup_idx uses as its DB conflict key (lower(producer),
-- lower(name), coalesce(vintage,0), size_ml) — see
-- src/domains/import/dedup-key.ts for the TypeScript mirror of this exact
-- key (the P2 seam: when resolve_wine_variants_bulk, 0099, lands on a
-- merged branch, both this SQL and dedup-key.ts swap to keying on
-- wine_variant_id instead, in one place each).
--
-- Session validation: RLS on import_sessions (0102) already makes a
-- foreign-tenant session id invisible to a plain SELECT — the same
-- fail-closed idiom revert_import_batch (0076) established. This function
-- additionally checks the visible session's restaurant_id against
-- p_restaurant_id explicitly (not just "found/not found") so a session id
-- that IS visible (same restaurant, real) but was typo'd/spoofed to a
-- DIFFERENT-tenant value can never silently succeed against the wrong
-- tenant's data — defense in depth, same posture as apply_import_batch_
-- chunk's own C17 tenant re-validation (0082).
--
-- DOWN: drops the function. confirmImportBatch's caller would need
-- reverting to the pre-P3 two-.insert()-calls body to function at all
-- without this RPC — out of scope for a DB-only down migration (see
-- 0106's down for the same note).

-- Supports tier 2(b)'s sibling-batch dedup lookup: the exact 6-expression
-- key (producer/name/vintage/size_ml/bin/section, normalized) the UPDATE
-- below joins on. import_batch_rows has no functional index on any of
-- these jsonb-derived expressions otherwise, so without this the planner
-- has nothing but a sequential scan + hash join to work with once a
-- session's row count grows across several chunks — measured to matter at
-- the 4,000-8,000-row-per-session scale a real chunked import produces
-- (see this migration's own performance note in the P3 hand-off report).
-- Plain (not `concurrently`) — see 0012's precedent, cited in the design
-- doc: acceptable at this table's expected scale (bulk-import metadata,
-- thousands of rows per session, not the inventory itself); if this table
-- ever grows enough that a brief ACCESS EXCLUSIVE lock is a concern, an
-- operator should run the `concurrently` form by hand before this
-- migration runs again.
create index import_batch_rows_dedup_key_idx on public.import_batch_rows (
  (lower(btrim(raw ->> 'producer'))),
  (lower(btrim(raw ->> 'name'))),
  (coalesce(nullif(raw ->> 'vintage', '')::int, 0)),
  (coalesce(nullif(raw ->> 'size_ml', '')::int, 750)),
  (upper(btrim(coalesce(raw ->> 'bin', '')))),
  (upper(btrim(coalesce(raw ->> 'section', ''))))
);

create or replace function public.create_import_batch(
  p_restaurant_id  uuid,
  p_created_by     uuid,
  p_filename       text,
  p_total_rows     integer,
  p_rows           jsonb,
  p_session_id     uuid default null,
  p_chunk_index    integer default null,
  p_chunk_total    integer default null,
  p_content_sha256 text default null,
  p_source_sha256  text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_batch_id uuid;
  v_session_restaurant_id uuid;
  v_session_source_sha256 text;
begin
  if p_session_id is not null then
    select restaurant_id, source_sha256
      into v_session_restaurant_id, v_session_source_sha256
      from public.import_sessions
      where id = p_session_id;

    if v_session_restaurant_id is null then
      raise exception 'import session % not found', p_session_id using errcode = 'P0002';
    end if;

    if v_session_restaurant_id <> p_restaurant_id then
      raise exception 'import session % does not belong to this restaurant', p_session_id
        using errcode = 'P0002';
    end if;

    if v_session_source_sha256 is not null
       and p_source_sha256 is not null
       and v_session_source_sha256 <> p_source_sha256 then
      raise exception 'chunk source file does not match this session''s source file'
        using errcode = 'P0006';
    end if;
  end if;

  insert into public.import_batches (
    restaurant_id, created_by, filename, total_rows,
    session_id, chunk_index, chunk_total, content_sha256
  ) values (
    p_restaurant_id, p_created_by, p_filename, p_total_rows,
    p_session_id, p_chunk_index, p_chunk_total, p_content_sha256
  )
  returning id into v_batch_id;

  -- Single multi-row INSERT — atomic on its own (0076's own header makes
  -- the same point about the original two-statement design), and now
  -- inside this function's own implicit transaction alongside the batch
  -- insert above: any row here that fails a CHECK/FK constraint aborts
  -- the WHOLE function call, rolling back the batch insert too.
  insert into public.import_batch_rows (
    batch_id, restaurant_id, row_number, raw, row_state, validation_errors,
    lwin_status, lwin_id, lwin_score, cost_status, resolution, duplicate_reason
  )
  select
    v_batch_id, p_restaurant_id, x.row_number, x.raw, x.row_state, x.validation_errors,
    x.lwin_status, x.lwin_id, x.lwin_score, x.cost_status, x.resolution, x.duplicate_reason
  from jsonb_to_recordset(p_rows) as x(
    row_number integer, raw jsonb, row_state text, validation_errors jsonb,
    lwin_status text, lwin_id text, lwin_score real, cost_status text,
    resolution text, duplicate_reason jsonb
  );

  -- Tier 2(a) (§1.5): flag rows whose resolved wine identity + normalized
  -- location already has an APPLIED inventory_items row from any other,
  -- already-confirmed batch (or pre-existing manual inventory). One
  -- set-based UPDATE over this batch's rows (bounded to <= MAX_ROWS),
  -- joined against wines/inventory_items filtered by restaurant — not a
  -- per-row loop, so this is one query plan regardless of batch size.
  -- Multiple matching inventory_items rows for one nr row is possible in
  -- principle (Postgres picks one arbitrarily per UPDATE...FROM
  -- semantics) but not expected in practice — a well-formed cellar has at
  -- most one inventory_items row per (wine, bin, section) triple even
  -- though the schema doesn't enforce it (§1.2's own reasoning for why a
  -- bare unique(wine_id) would be wrong).
  --
  -- Filtered on `resolution <> 'exclude'`, NOT `resolution in ('auto',
  -- 'include')` — deliberately wider than "currently apply-eligible".
  -- duplicate_reason is an independent fact from WHY a row is pending: a
  -- row can be simultaneously LWIN-unmatched (or missing-cost) AND a
  -- duplicate, and the operator-facing UI needs to see both, not just
  -- whichever pending-cause happened to be computed first. Excluding only
  -- 'exclude' rows (error rows, or an operator's explicit "no") is
  -- correct because those can never be applied regardless — checking them
  -- for duplicates would be pure waste, never a missed signal.
  update public.import_batch_rows nr
  set resolution = 'pending',
      duplicate_reason = jsonb_build_object(
        'type', 'existing_inventory',
        'matchedInventoryItemId', ii.id,
        'existingQuantity', ii.quantity
      )
  from public.wines w
  join public.inventory_items ii on ii.wine_id = w.id
  where nr.batch_id = v_batch_id
    and nr.resolution <> 'exclude'
    and w.restaurant_id = p_restaurant_id
    and ii.restaurant_id = p_restaurant_id
    and lower(btrim(w.producer)) = lower(btrim(nr.raw ->> 'producer'))
    and lower(btrim(w.name)) = lower(btrim(nr.raw ->> 'name'))
    and coalesce(w.vintage, 0) = coalesce(nullif(nr.raw ->> 'vintage', '')::int, 0)
    and w.size_ml = coalesce(nullif(nr.raw ->> 'size_ml', '')::int, 750)
    and upper(btrim(coalesce(ii.bin_location, ''))) = upper(btrim(coalesce(nr.raw ->> 'bin', '')))
    and upper(btrim(coalesce(ii.section, ''))) = upper(btrim(coalesce(nr.raw ->> 'section', '')));

  -- Tier 2(b) (§3.3): closes the TOCTOU gap tier 2(a) alone can't —  two
  -- sibling chunks of the SAME session both confirmed but neither yet
  -- applied have no applied inventory_items row for (a) to find. Only the
  -- chunk being confirmed NOW is flagged; an already-confirmed sibling
  -- row already sitting in the session is left untouched (§3.3's own
  -- worked example: chunk 4's row is flagged without requiring chunk 1 to
  -- have been applied first).
  if p_session_id is not null then
    update public.import_batch_rows nr
    set resolution = 'pending',
        duplicate_reason = jsonb_build_object(
          'type', 'sibling_batch',
          'matchedRowId', sib.id,
          'existingQuantity', coalesce(nullif(sib.raw ->> 'quantity', '')::int, 0)
        )
    from public.import_batch_rows sib
    join public.import_batches sb on sb.id = sib.batch_id
    where nr.batch_id = v_batch_id
      and nr.resolution <> 'exclude'
      and sb.session_id = p_session_id
      and sib.batch_id <> v_batch_id
      and sib.apply_status = 'not_applied'
      and sib.resolution <> 'exclude'
      and lower(btrim(sib.raw ->> 'producer')) = lower(btrim(nr.raw ->> 'producer'))
      and lower(btrim(sib.raw ->> 'name')) = lower(btrim(nr.raw ->> 'name'))
      and coalesce(nullif(sib.raw ->> 'vintage', '')::int, 0) = coalesce(nullif(nr.raw ->> 'vintage', '')::int, 0)
      and coalesce(nullif(sib.raw ->> 'size_ml', '')::int, 750) = coalesce(nullif(nr.raw ->> 'size_ml', '')::int, 750)
      and upper(btrim(coalesce(sib.raw ->> 'bin', ''))) = upper(btrim(coalesce(nr.raw ->> 'bin', '')))
      and upper(btrim(coalesce(sib.raw ->> 'section', ''))) = upper(btrim(coalesce(nr.raw ->> 'section', '')));
  end if;

  return jsonb_build_object('batchId', v_batch_id);
end;
$$;

comment on function public.create_import_batch(uuid, uuid, text, integer, jsonb, uuid, integer, integer, text, text) is
  'C09 (db audit 2026-08-23): batch insert + rows insert + tier-2 dedup '
  'flagging in ONE function call''s implicit transaction — a rows-insert '
  'failure rolls back the batch insert too, so an orphaned empty batch can '
  'no longer exist. Raises 23505 on a duplicate content_sha256 or '
  '(session_id, chunk_index) — callers look up and return the pre-existing '
  'batch as a resume pointer (P3 §2.2) rather than treating it as a bare '
  'rejection. SECURITY INVOKER: RLS on import_batches/import_batch_rows/ '
  'import_sessions is the tenant boundary.';

revoke all on function public.create_import_batch(uuid, uuid, text, integer, jsonb, uuid, integer, integer, text, text) from public;
grant execute on function public.create_import_batch(uuid, uuid, text, integer, jsonb, uuid, integer, integer, text, text) to authenticated;
