-- down for 0080_wine_list_items_tenant_fk.sql
--
-- Restores the pre-fix INSERT/UPDATE policies verbatim, drops the
-- section-restaurant trigger, the composite FK, the restaurant_id column,
-- and the wines(id, restaurant_id) uniqueness constraint.
--
-- Re-introduces C05's cross-tenant wine/section linkage hole — only for a
-- rollback of this specific fix, never as a normal operation.

begin;

drop policy "members can update their list items" on public.wine_list_items;
create policy "members can update their list items"
  on public.wine_list_items for update to authenticated
  using (exists (
    select 1 from public.wine_list_sections s
    join public.wine_lists wl on wl.id = s.wine_list_id
    where s.id = section_id and public.is_member(wl.restaurant_id)
  ));

drop policy "members can insert list items" on public.wine_list_items;
create policy "members can insert list items"
  on public.wine_list_items for insert to authenticated
  with check (exists (
    select 1 from public.wine_list_sections s
    join public.wine_lists wl on wl.id = s.wine_list_id
    where s.id = section_id and public.is_member(wl.restaurant_id)
  ));

drop trigger if exists wine_list_items_enforce_section_restaurant on public.wine_list_items;
drop function if exists public.wine_list_items_enforce_section_restaurant();

alter table public.wine_list_items
  drop constraint if exists wine_list_items_wine_restaurant_fkey;

alter table public.wine_list_items
  drop column if exists restaurant_id;

alter table public.wines
  drop constraint if exists wines_id_restaurant_id_key;

commit;
