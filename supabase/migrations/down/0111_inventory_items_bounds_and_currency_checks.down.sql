-- Reverse of 0111_inventory_items_bounds_and_currency_checks.sql

alter table public.inventory_items
  drop constraint if exists inventory_items_currency_allowlist,
  drop constraint if exists inventory_items_unit_cost_upper_bound,
  drop constraint if exists inventory_items_quantity_upper_bound;
