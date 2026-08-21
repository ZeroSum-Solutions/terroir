-- Restore the table privileges required by Supabase's Data API roles.
--
-- The local bootstrap intentionally removes DML from postgres-owned default
-- privileges. Terroir migrations run as postgres, so RLS policies alone are
-- insufficient: the API roles also need table privileges before RLS can
-- evaluate a request.

grant select, insert, update, delete
  on all tables in schema public
  to authenticated, service_role;

-- Anonymous clients only need the published-menu read graph. The existing
-- SELECT policies continue to hide drafts and tenant-private rows.
grant select
  on table
    public.restaurants,
    public.wine_lists,
    public.wine_list_sections,
    public.wine_list_items,
    public.wines
  to anon;

-- service_role is the trusted server-side maintenance role. Preserve its DML
-- access for future postgres-owned public tables without widening defaults for
-- anon or authenticated.
alter default privileges for role postgres in schema public
  grant select, insert, update, delete on tables to service_role;
