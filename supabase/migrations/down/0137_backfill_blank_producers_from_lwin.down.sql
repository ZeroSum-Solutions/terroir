-- Down for 0137 — restores every producer the backfill overwrote, and only
-- those.
--
-- producer_backfill_audit holds the prior value for each of the 956 rows 0137
-- wrote, so this is an exact reversal rather than a blanket "set producer to ''
-- where it looks derived". Rows 0137 declined to repair were never written and
-- have no audit row, so they are untouched here too.
--
-- The wines.wine_variant_id / canonical_wine_id values that resolution produced
-- are deliberately LEFT IN PLACE, following 0135's down and 0101's before it.
-- They are correct identity data — resolve_wine_variants_bulk matched them on a
-- producer that was genuinely that wine's producer — and nulling them would
-- destroy real canonical_wines / wine_variants relationships in order to undo a
-- text column. If the identity links are what you actually want gone, that is a
-- separate, deliberate operation.
--
-- Reverting therefore returns the *display* data to its imported state while
-- leaving the spine resolved. The wines will show a blank producer again and
-- new resolution attempts on them will go back to failing.

update public.wines w
   set producer = a.old_producer
  from public.producer_backfill_audit a
 where a.wine_id = w.id
   and a.migration = '0137'
   -- Only revert rows still holding the value 0137 wrote. Anything edited by a
   -- human since then is theirs, not ours to roll back.
   and w.producer = a.new_producer;

delete from public.producer_backfill_audit where migration = '0137';

-- The table is 0137's own; nothing else writes it.
drop table if exists public.producer_backfill_audit;
