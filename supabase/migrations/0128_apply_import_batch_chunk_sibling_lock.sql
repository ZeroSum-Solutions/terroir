-- Cross-batch apply barrier for CSV import.
--
-- Closes the race documented as an accepted residual in
-- docs/runbooks/csv-import.md: "at most one applied batch per underlying file"
-- had no enforcement point. See the inline comment on the barrier below for why
-- the previous route-level guard could not close it.
--
-- Function-only change. No table, column, index, or grant is altered, so this is
-- safe to run against production data that ALREADY violates the invariant: the
-- migration itself never fails on such rows. After deployment, a batch in an
-- already-violating group is refused (P0004) while another member still has
-- applied rows; an operator picks a survivor and reverts the others.
--
-- Deploy the migration BEFORE the application build that removes the route-level
-- guard, or the race is briefly reopened.

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
  v_restaurant_id uuid;
  v_content_sha256 text;
  v_file_digest text;
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
  select restaurant_id, status, content_sha256
    into v_restaurant_id, v_batch_status, v_content_sha256
    from public.import_batches
    where id = p_batch_id
    for update;

  if not found then
    raise exception 'import batch % not found', p_batch_id using errcode = 'P0002';
  end if;

  if v_batch_status = 'reverted' then
    return; -- no-op: a reverted batch can never be re-applied into.
  end if;

  -- Cross-batch apply barrier. Before this migration the invariant "at most one
  -- APPLIED batch per underlying file" had no enforcement point anywhere: the
  -- route-level sibling check (findSiblingWithAppliedRows) ran in a SEPARATE
  -- transaction from this RPC, making it a TOCTOU check rather than a barrier,
  -- and this function's `for update` above locks only its OWN batch row, so two
  -- sibling batches never serialised against each other. The RPC is also granted
  -- directly to `authenticated`, so the route guard was never a security
  -- boundary — a direct RPC call bypassed it entirely.
  --
  -- The digest normalisation mirrors the TypeScript readers exactly
  -- (OVERRIDES_DIGEST_STEM in src/domains/import/batch-service.ts): a digest is
  -- either bare 64-hex, or `overrides-v<N>:<64-hex>:<64-hex>` where the trailing
  -- 64 hex chars identify the underlying FILE. Generalising over [0-9]+ rather
  -- than a fixed version keeps v1..v4 — and any later namespace — normalising to
  -- the same file identity.
  --
  -- Historic null/malformed pre-0103 digests are GRANDFATHERED: their underlying
  -- file identity cannot be recovered, so they take no lock and get no check,
  -- exactly as before. Narrowing that would break existing production batches.
  if v_content_sha256 ~ '^[0-9a-f]{64}$' then
    v_file_digest := v_content_sha256;
  elsif v_content_sha256 ~ '^overrides-v[0-9]+:[0-9a-f]{64}:[0-9a-f]{64}$' then
    v_file_digest := right(v_content_sha256, 64);
  else
    v_file_digest := null;
  end if;

  if v_file_digest is not null then
    -- Transaction-scoped: released at commit/rollback, so it cannot leak across
    -- pooled connections. Keyed by tenant + underlying file, so unrelated files
    -- and unrelated tenants almost never contend — hashtextextended yields a
    -- 64-bit key, so a collision between two distinct (tenant, file) strings is
    -- possible. A collision costs only serialisation latency, never a false
    -- P0004: the under-lock query below still matches on the exact restaurant
    -- and the exact digest. Repeated chunk calls for the SAME
    -- batch already serialise on the batch row's `for update` above and take the
    -- same key here without self-conflict (a session re-acquiring its own
    -- advisory lock is a no-op within one transaction).
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_restaurant_id::text || ':' || v_file_digest, 0)
    );

    -- Now that the lock is held, re-check INSIDE this transaction. This is the
    -- part the route guard could not do: any competing sibling apply is either
    -- still waiting on the lock above (and will see our rows once we commit) or
    -- already committed (and we see its rows here).
    if exists (
      select 1
      from public.import_batches sibling
      join public.import_batch_rows sibling_row
        on sibling_row.batch_id = sibling.id
      where sibling.restaurant_id = v_restaurant_id
        and sibling.id <> p_batch_id
        and sibling_row.apply_status = 'applied'
        and (
          sibling.content_sha256 = v_file_digest
          or sibling.content_sha256 ~ ('^overrides-v[0-9]+:[0-9a-f]{64}:' || v_file_digest || '$')
        )
    ) then
      raise exception
        'another import batch for this underlying file already has applied rows'
        using errcode = 'P0004';
    end if;
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
  'Applies up to p_limit not-yet-applied, eligible rows of one import batch. '
  'Locks and checks batch status first; a reverted batch is a hard no-op. '
  'Cross-batch barrier: normalises bare and overrides-vN content digests to the '
  'underlying file identity, takes a transaction-scoped advisory lock keyed by '
  '(restaurant, file), then atomically refuses with P0004 when a SIBLING batch '
  'for the same file already has applied rows. Historic null/malformed pre-0103 '
  'digests are grandfathered and take no lock. Per-row retry accounting and the '
  '0.6 LWIN persistence threshold are unchanged from 0108. FOR UPDATE SKIP '
  'LOCKED still prevents double-applying a row. SECURITY INVOKER: RLS remains '
  'the tenant boundary.';

revoke all on function public.apply_import_batch_chunk(uuid, integer) from public;
grant execute on function public.apply_import_batch_chunk(uuid, integer) to authenticated;
