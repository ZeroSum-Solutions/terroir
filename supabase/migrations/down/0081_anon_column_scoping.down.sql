-- down for 0081_anon_column_scoping.sql
--
-- Restores the pre-fix blanket anon table-level SELECT on wines and
-- restaurants (all columns, including the pricing-strategy/ops columns
-- this migration hid) and the pre-fix wine_list_items anon policy (no
-- hidden check). Re-introduces C06's anon column/hidden-item leak — only
-- for a rollback of this specific fix, never as a normal operation.

begin;

drop policy "published list items are public" on public.wine_list_items;
create policy "published list items are public"
  on public.wine_list_items for select to anon
  using (exists (
    select 1 from public.wine_list_sections s
    join public.wine_lists wl on wl.id = s.wine_list_id
    where s.id = section_id and wl.is_published = true
  ));

revoke select on table public.wines, public.restaurants from anon;

grant select on table public.wines, public.restaurants to anon;

commit;
