-- 0056_lineage_hardening.down.sql
-- Restore the 0055 trigger scope (no lineage_id watch); the 0055 function
-- body is create-or-replace and can be re-applied from that migration.

drop trigger if exists wines_derive_lineage on public.wines;
create trigger wines_derive_lineage
  before insert or update of lwin_id, producer, name
  on public.wines
  for each row execute function public.derive_wine_lineage();
