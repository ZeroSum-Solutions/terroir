-- 0088_undo_last_pour_single_reversal.sql
--
-- C22 (db audit 2026-08-23, verified V4-bottles.md) — undo_last_pour
-- (0040) manually reverses a pour event's ml_delta onto open_bottles,
-- then deletes the pour_events row; the AFTER DELETE trigger added later
-- (pour_events_reverse_open_bottle, 0050) independently reverses the same
-- delete. Verified reproduction: 750ml bottle, poured 150ml (600ml
-- remaining), undo_last_pour -> remaining_ml = 900 (should be 750).
-- Isolated proof (disabling the trigger for one transaction, then rolling
-- back): with the trigger off, the manual reversal alone correctly
-- produces 750ml — confirming the trigger is the second, redundant
-- reverser, not the manual code.
--
-- Fix (per the fix sketch's first option): remove the manual reversal
-- from undo_last_pour and let the AFTER DELETE trigger (0050) be the
-- sole reversal mechanism. The trigger's own reversal for kind IN
-- ('pour','spill','finish_bottle') is byte-for-byte the same
-- computation the manual branch performed
-- (remaining_ml = remaining_ml + OLD.ml_delta), so removing the
-- duplicate returns to the single, correct reversal — nothing else
-- about undo's behavior changes.
--
-- The rejected alternative (disable/bypass the trigger for undo's own
-- delete via ALTER TABLE ... DISABLE TRIGGER) was measured and rejected:
-- ALTER TABLE ... DISABLE/ENABLE TRIGGER takes a SHARE ROW EXCLUSIVE lock
-- on pour_events, which conflicts with the ROW EXCLUSIVE lock every
-- concurrent pour/spill/reconcile INSERT needs — every undo would
-- serialize against every pour, tenant-wide, on a table that exists
-- specifically to record high-frequency events. Removing the duplicate
-- update carries no such cost.
--
-- Also removes the "else" branch that recreated a deleted open_bottles
-- row: verified dead code in the current schema. open_bottles rows have
-- not been deleted since 0044 (drained bottles get closed_at set
-- instead), and pour_events.wine_id is ON DELETE RESTRICT (0016), so a
-- wine with any pour_events can never be deleted either — the row this
-- branch existed to recreate cannot be missing while a pour/spill event
-- referencing it (with open_bottle_id IS NOT NULL, per undo's own
-- eligibility filter) still exists. Left in place, this branch would
-- silently INSERT a duplicate row into a table with a wine_id+
-- restaurant_id UNIQUE constraint (0016) the moment it ever did execute,
-- which is strictly worse than raising loudly if the "impossible" case
-- is ever hit — this migration raises instead.
--
-- Belt-and-suspenders (per the fix sketch's second half): adds a
-- BEFORE INSERT OR UPDATE invariant trigger on open_bottles rejecting any
-- remaining_ml that would exceed its wine's size_ml. reconcile_open_bottle
-- (0044) already enforces this at the call site; this closes the same gap
-- at the table level so a FUTURE double-reversal-shaped bug fails loudly
-- (an exception) instead of silently producing physically impossible
-- state like the verified 900ml-in-a-750ml-bottle. Skips wines with a
-- null size_ml (nothing to bound against).
--
-- DOWN: restores undo_last_pour to its exact pre-fix (0040) body
-- (reintroducing the double-reversal bug) and drops the invariant
-- trigger. See down/0088_undo_last_pour_single_reversal.down.sql.

-- ── 1. undo_last_pour: single reversal, no dead-code recreate branch ────

create or replace function public.undo_last_pour(
  p_wine_id uuid
) returns public.open_bottles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_restaurant_id uuid;
  v_event         public.pour_events%rowtype;
  v_current       public.open_bottles%rowtype;
  v_user          uuid := auth.uid();
begin
  -- Auth check: must be a member of this wine's restaurant.
  select restaurant_id into v_restaurant_id
    from public.wines where id = p_wine_id;
  if v_restaurant_id is null then
    raise exception 'wine not found';
  end if;

  if not public.is_member_with_role(v_restaurant_id, 'staff') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Find the most recent pour or spill event for this wine
  -- that has an open_bottle_id (i.e., was recorded against a specific bottle).
  select * into v_event
    from public.pour_events
    where wine_id = p_wine_id
      and restaurant_id = v_restaurant_id
      and kind in ('pour', 'spill')
      and open_bottle_id is not null
    order by occurred_at desc
    limit 1
    for update;

  if not found then
    raise exception 'no recent pour to undo';
  end if;

  -- Lock the current open_bottles row. C22 (db audit 2026-08-23): this
  -- row is not manually updated any more — the AFTER DELETE trigger
  -- (pour_events_reverse_open_bottle, 0050) is the sole reversal
  -- mechanism, fired by the delete below. Locking it here still
  -- serializes concurrent undo/pour calls on the same bottle.
  select * into v_current
    from public.open_bottles
    where wine_id = p_wine_id and restaurant_id = v_restaurant_id
    for update;

  if not found then
    -- Verified unreachable in the current schema (see migration header)
    -- — fail loudly rather than silently recreate a row the trigger
    -- below has nothing to reverse against.
    raise exception 'no open bottle found to restore for wine %', p_wine_id;
  end if;

  -- Delete the pour event (the undo action). The AFTER DELETE trigger
  -- (0050) reverses OLD.ml_delta back onto open_bottles.remaining_ml.
  delete from public.pour_events
    where id = v_event.id;

  -- Insert an availability event to record the undo.
  insert into public.availability_events
    (wine_id, restaurant_id, direction, user_id, note)
  values
    (p_wine_id, v_restaurant_id, 'restored', v_user, 'undo pour: ' || v_event.ml_delta || 'ml restored');

  -- Return the updated open_bottles row.
  select * into v_current
    from public.open_bottles
    where wine_id = p_wine_id and restaurant_id = v_restaurant_id;
  return v_current;
end;
$$;

grant execute on function public.undo_last_pour(uuid) to authenticated;

-- ── 2. Capacity invariant: remaining_ml can never exceed the wine's size ─

create or replace function public.open_bottles_enforce_capacity()
returns trigger
language plpgsql
as $$
declare
  v_size_ml int;
begin
  select size_ml into v_size_ml from public.wines where id = NEW.wine_id;
  if v_size_ml is not null and NEW.remaining_ml > v_size_ml then
    raise exception 'open_bottles.remaining_ml (%) would exceed wine % size_ml (%)',
      NEW.remaining_ml, NEW.wine_id, v_size_ml
      using errcode = 'P0003';
  end if;
  return NEW;
end;
$$;

comment on function public.open_bottles_enforce_capacity() is
  'C22 (db audit 2026-08-23): defense-in-depth invariant — no write path '
  'may leave open_bottles.remaining_ml greater than its wine''s size_ml. '
  'reconcile_open_bottle (0044) already checks this at the call site; '
  'this closes the same gap at the table level so a future double-'
  'reversal-shaped bug (like the one this migration fixes) fails loudly '
  'instead of producing physically impossible state.';

create trigger open_bottles_enforce_capacity_trigger
  before insert or update on public.open_bottles
  for each row execute function public.open_bottles_enforce_capacity();
