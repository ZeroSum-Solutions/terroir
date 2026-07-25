-- Reverse migration 0068.
drop function if exists public.reorder_wine_list_sections(uuid[]);
drop function if exists public.create_wine_list_section(uuid, uuid, text);
