-- TER-021E — private, bounded wine-list PDF worker artifacts.
--
-- One object exists per restaurant/list/template. Worker retries upsert the
-- same canonical path, and later exports replace the previous snapshot rather
-- than accumulating an unbounded artifact history.

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'generated-exports',
  'generated-exports',
  false,
  10485760,
  array['application/pdf']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.wine_list_pdf_artifact_tenant_id(p_name text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_parts text[];
begin
  v_parts := pg_catalog.regexp_match(
    p_name,
    '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_(classic|modern|minimal)\.pdf$'
  );
  if v_parts is null then
    return null;
  end if;

  if not exists (
    select 1
    from public.wine_lists as list
    where list.restaurant_id = v_parts[1]::uuid
      and list.id = v_parts[2]::uuid
  ) then
    return null;
  end if;

  return v_parts[1]::uuid;
end;
$$;

revoke all on function public.wine_list_pdf_artifact_tenant_id(text)
  from public;
grant execute on function public.wine_list_pdf_artifact_tenant_id(text)
  to authenticated;

drop policy if exists "members can read generated exports" on storage.objects;
create policy "members can read generated exports"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'generated-exports'
    and public.wine_list_pdf_artifact_tenant_id(name) is not null
    and public.is_member(public.wine_list_pdf_artifact_tenant_id(name))
  );

-- Authenticated clients receive read access only. The isolated service-role
-- worker owns insert/update, while tenant deletion uses its existing server-
-- side cleanup path before removing the restaurant.
