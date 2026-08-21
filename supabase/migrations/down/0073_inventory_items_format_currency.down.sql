-- 0073_inventory_items_format_currency.down.sql
-- Remove format and currency columns from inventory_items.

alter table public.inventory_items
  drop column if exists format,
  drop column if exists currency;
