-- Remove the Data API table grants added by 0074_public_api_grants.sql.

alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from service_role;

revoke select
  on table
    public.restaurants,
    public.wine_lists,
    public.wine_list_sections,
    public.wine_list_items,
    public.wines
  from anon;

revoke select, insert, update, delete
  on all tables in schema public
  from authenticated, service_role;
