-- TER-024 — private, tenant-scoped object storage and user-data lifecycle.
--
-- This migration is intentionally fail-closed: all newly reachable image
-- objects are private, policy predicates validate their full canonical path,
-- and user-attribution foreign keys become nullable on Auth-user deletion.
-- It does not schedule destructive retention work; production retention runs
-- require the backup and approval procedure in docs/runbooks/data-lifecycle-privacy.md.

-- A private bucket is the prerequisite for short-lived signed URLs. Keep both
-- application buckets aligned with the API's 10 MiB input limit.
update storage.buckets
set public = false,
    file_size_limit = 10485760
where id in ('invoice-images', 'wine-images');

-- Return a tenant UUID only from a canonical tenant prefix. Resource-specific
-- functions below validate the exact object shapes the app writes. The regex
-- runs before the cast so a malformed object name cannot turn an RLS check
-- into a database error.
create or replace function public.storage_tenant_prefix_id(p_name text)
returns uuid
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  v_parts text[];
begin
  v_parts := pg_catalog.regexp_match(
    p_name,
    '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.+$'
  );
  if v_parts is null then
    return null;
  end if;
  return v_parts[1]::uuid;
end;
$$;

create or replace function public.invoice_image_tenant_id(p_name text)
returns uuid
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  v_parts text[];
begin
  v_parts := pg_catalog.regexp_match(
    p_name,
    '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_page[1-9][0-9]*)?\.(?:jpg|jpeg|png|heic|heif|pdf)$'
  );
  if v_parts is null then
    return null;
  end if;
  return v_parts[1]::uuid;
end;
$$;

create or replace function public.wine_image_tenant_id(p_name text)
returns uuid
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  v_parts text[];
begin
  v_parts := pg_catalog.regexp_match(
    p_name,
    '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(?:jpg|png|webp)$'
  );
  if v_parts is null then
    return null;
  end if;
  return v_parts[1]::uuid;
end;
$$;

-- Inserts and renames must also resolve to an existing object owner. DELETE
-- deliberately uses the tenant prefix plus membership so cleanup can remove
-- a tenant's legacy or already-detached object after its row is deleted.
create or replace function public.is_valid_invoice_image_path(p_name text)
returns boolean
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
    '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_page[1-9][0-9]*)?\.(?:jpg|jpeg|png|heic|heif|pdf)$'
  );
  if v_parts is null then
    return false;
  end if;

  return exists (
    select 1
    from public.invoice_scans as scan
    where scan.restaurant_id = v_parts[1]::uuid
      and scan.id = v_parts[2]::uuid
  );
end;
$$;

create or replace function public.is_valid_wine_image_path(p_name text)
returns boolean
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
    '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(?:jpg|png|webp)$'
  );
  if v_parts is null then
    return false;
  end if;

  return exists (
    select 1
    from public.wines as wine
    where wine.restaurant_id = v_parts[1]::uuid
      and wine.id = v_parts[2]::uuid
  );
end;
$$;

revoke all on function public.invoice_image_tenant_id(text) from public;
revoke all on function public.wine_image_tenant_id(text) from public;
revoke all on function public.storage_tenant_prefix_id(text) from public;
revoke all on function public.is_valid_invoice_image_path(text) from public;
revoke all on function public.is_valid_wine_image_path(text) from public;
grant execute on function public.invoice_image_tenant_id(text) to authenticated;
grant execute on function public.wine_image_tenant_id(text) to authenticated;
grant execute on function public.storage_tenant_prefix_id(text) to authenticated;
grant execute on function public.is_valid_invoice_image_path(text) to authenticated;
grant execute on function public.is_valid_wine_image_path(text) to authenticated;

drop policy if exists "members can upload invoice images" on storage.objects;
drop policy if exists "members can read invoice images" on storage.objects;
drop policy if exists "members can update invoice images" on storage.objects;
drop policy if exists "owners can delete invoice images" on storage.objects;

create policy "members can upload invoice images"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'invoice-images'
    and public.storage_tenant_prefix_id(name) is not null
    and public.is_member(public.storage_tenant_prefix_id(name))
    and public.is_valid_invoice_image_path(name)
  );

create policy "members can read invoice images"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'invoice-images'
    and public.storage_tenant_prefix_id(name) is not null
    and public.is_member(public.storage_tenant_prefix_id(name))
  );

create policy "members can update invoice images"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'invoice-images'
    and public.storage_tenant_prefix_id(name) is not null
    and public.is_member(public.storage_tenant_prefix_id(name))
  )
  with check (
    bucket_id = 'invoice-images'
    and public.invoice_image_tenant_id(name) is not null
    and public.is_member(public.invoice_image_tenant_id(name))
    and public.is_valid_invoice_image_path(name)
  );

create policy "owners can delete invoice images"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'invoice-images'
    and public.storage_tenant_prefix_id(name) is not null
    and public.is_member_with_role(
      public.storage_tenant_prefix_id(name),
      'owner'
    )
  );

drop policy if exists "managers can insert wine images" on storage.objects;
drop policy if exists "managers can update wine images" on storage.objects;
drop policy if exists "managers can delete wine images" on storage.objects;
drop policy if exists "members can read wine images" on storage.objects;

create policy "members can read wine images"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'wine-images'
    and public.storage_tenant_prefix_id(name) is not null
    and public.is_member(public.storage_tenant_prefix_id(name))
  );

create policy "managers can insert wine images"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'wine-images'
    and public.storage_tenant_prefix_id(name) is not null
    and public.is_member_with_role(public.storage_tenant_prefix_id(name), 'manager')
    and public.is_valid_wine_image_path(name)
  );

create policy "managers can update wine images"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'wine-images'
    and public.storage_tenant_prefix_id(name) is not null
    and public.is_member_with_role(public.storage_tenant_prefix_id(name), 'manager')
  )
  with check (
    bucket_id = 'wine-images'
    and public.storage_tenant_prefix_id(name) is not null
    and public.is_member_with_role(public.storage_tenant_prefix_id(name), 'manager')
    and public.is_valid_wine_image_path(name)
  );

create policy "managers can delete wine images"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'wine-images'
    and public.storage_tenant_prefix_id(name) is not null
    and public.is_member_with_role(public.storage_tenant_prefix_id(name), 'manager')
  );

-- `hero_image_url` originally stored a public URL. It now stores only the
-- canonical private object path so existing API payloads stay compatible while
-- every presentation path must mint a short-lived signed URL. Normalize only
-- paths that can be proven to belong to the current wine; ambiguous legacy
-- values fail closed and are documented for owner re-upload.
with legacy_paths as (
  select
    wine.id,
    pg_catalog.lower(
      pg_catalog.regexp_replace(
        wine.hero_image_url,
        '^https?://[^/]+/storage/v1/object/public/wine-images/',
        ''
      )
    ) as object_path
  from public.wines as wine
  where wine.hero_image_url ~ '^https?://[^/]+/storage/v1/object/public/wine-images/'
)
update public.wines as wine
set hero_image_url = legacy_paths.object_path
from legacy_paths
where wine.id = legacy_paths.id
  and legacy_paths.object_path ~ (
    '^' || wine.restaurant_id::text || '/' || wine.id::text || '\.(jpg|png|webp)$'
  );

comment on column public.wines.hero_image_url is
  'TER-024 compatibility name: canonical private wine-images object path, never a public URL. Presentation must use a short-lived signed URL.';

-- Auth user deletion must not be blocked by durable operational history.
-- Memberships and idempotency rows already cascade; the remaining attribution
-- columns become null while the restaurant-owned event remains intact.
alter table public.invitations
  alter column invited_by drop not null;

alter table public.invitations
  drop constraint if exists invitations_invited_by_fkey,
  add constraint invitations_invited_by_fkey
    foreign key (invited_by) references auth.users(id) on delete set null;

alter table public.invoice_scans
  drop constraint if exists invoice_scans_created_by_fkey,
  add constraint invoice_scans_created_by_fkey
    foreign key (created_by) references auth.users(id) on delete set null;

alter table public.wines
  drop constraint if exists wines_eightysixed_by_fkey,
  add constraint wines_eightysixed_by_fkey
    foreign key (eightysixed_by) references auth.users(id) on delete set null;

alter table public.availability_events
  drop constraint if exists availability_events_user_id_fkey,
  add constraint availability_events_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete set null;

alter table public.open_bottles
  drop constraint if exists open_bottles_opened_by_fkey,
  add constraint open_bottles_opened_by_fkey
    foreign key (opened_by) references auth.users(id) on delete set null;

alter table public.pour_events
  drop constraint if exists pour_events_actor_user_id_fkey,
  add constraint pour_events_actor_user_id_fkey
    foreign key (actor_user_id) references auth.users(id) on delete set null;

comment on table public.invoice_scans is
  'TER-024: invoice metadata and OCR are retained while the tenant is active. Restaurant deletion removes the tenant object prefixes before the database cascade.';
comment on table public.background_jobs is
  'TER-024: job metadata and result are restaurant-owned operational data. Do not place invoice text, images, URLs, credentials, or personal data in either JSON payload.';
comment on table public.invitations is
  'TER-024: invitation email and token are tenant-scoped; expired or cancelled invitations are operational cleanup candidates and are never emitted to telemetry.';
