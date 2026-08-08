-- TER-026 / TER-CF-095 + TER-CF-101 — commit manual wine metadata and
-- enrichment locks atomically so provider enrichment cannot overwrite a
-- successfully saved manual value.

-- The original wine UPDATE policy admitted every tenant member, which made
-- the API/UI manager boundary bypassable through the Supabase data API. Wine
-- mutations are a wine:manage capability, so database UPDATE authority must
-- match the shared owner/manager capability map.
drop policy if exists "members can update their wines" on public.wines;
drop policy if exists "owners and managers can update their wines" on public.wines;
create policy "owners and managers can update their wines"
  on public.wines for update to authenticated
  using (public.is_member_with_role(restaurant_id, 'manager'))
  with check (public.is_member_with_role(restaurant_id, 'manager'));

-- Supabase CLI's fresh local bootstrap can leave application-created tables
-- without data privileges. Grant only the table capabilities this policy and
-- the existing member-scoped SELECT policy are designed to govern; RLS remains
-- the server-side authorization boundary for every authenticated statement.
grant select, update on public.wines to authenticated;

-- Reinstall the manual-override-aware batch function with an explicit
-- database authorization check. SECURITY DEFINER is required so the function
-- can retain a narrow callable contract while the table policy independently
-- rejects direct staff updates; every updated row remains tenant-bound below.
create or replace function public.enrich_wines_batch(
  p_restaurant_id uuid,
  p_enrichments jsonb
) returns integer
language plpgsql
security definer
set search_path = ''
as $func$
declare
  v_count integer;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;
  if not public.is_member_with_role(p_restaurant_id, 'manager') then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_enrichments is null
     or jsonb_typeof(p_enrichments) <> 'array'
     or jsonb_array_length(p_enrichments) = 0 then
    return 0;
  end if;
  if jsonb_array_length(p_enrichments) > 2000
     or exists (
       select 1
       from jsonb_array_elements(p_enrichments) as item
       where jsonb_typeof(item) <> 'object'
     ) then
    raise exception using errcode = '22023', message = 'invalid wine enrichment batch';
  end if;

  with u as (
    select
      (e->>'id')::uuid                   as id,
      (e->>'drink_window_start')::int    as drink_window_start,
      (e->>'drink_window_end')::int      as drink_window_end,
      (e->>'peak_year')::int             as peak_year,
      (e->>'rating')::numeric            as rating,
      (e->>'rating_source')              as rating_source,
      (e->>'review_excerpt')             as review_excerpt,
      (e->>'serving_temp_min')::int      as serving_temp_min,
      (e->>'serving_temp_max')::int      as serving_temp_max,
      (e->>'serving_temp_label')         as serving_temp_label,
      (e->>'decant_minutes')::int        as decant_minutes,
      (e->>'region')                     as region,
      (e->>'country')                    as country,
      (e->>'varietal')                   as varietal,
      (e->>'colour')                     as colour,
      (e->>'enrichment_metadata')::jsonb as enrichment_metadata
    from jsonb_array_elements(p_enrichments) as e
  )
  update public.wines as w
  set
    drink_window_start = case
      when 'drink_window' = any(w.manual_overrides) then w.drink_window_start
      else coalesce(u.drink_window_start, w.drink_window_start)
    end,
    drink_window_end = case
      when 'drink_window' = any(w.manual_overrides) then w.drink_window_end
      else coalesce(u.drink_window_end, w.drink_window_end)
    end,
    peak_year = case
      when 'drink_window' = any(w.manual_overrides) then w.peak_year
      else coalesce(u.peak_year, w.peak_year)
    end,
    region = case
      when 'region' = any(w.manual_overrides) then w.region
      else coalesce(u.region, w.region)
    end,
    country = case
      when 'country' = any(w.manual_overrides) then w.country
      else coalesce(u.country, w.country)
    end,
    varietal = case
      when 'varietal' = any(w.manual_overrides) then w.varietal
      else coalesce(u.varietal, w.varietal)
    end,
    colour = case
      when 'colour' = any(w.manual_overrides) then w.colour
      else coalesce(u.colour, w.colour)
    end,
    rating = coalesce(u.rating, w.rating),
    rating_source = coalesce(u.rating_source, w.rating_source),
    review_excerpt = coalesce(u.review_excerpt, w.review_excerpt),
    serving_temp_min = coalesce(u.serving_temp_min, w.serving_temp_min),
    serving_temp_max = coalesce(u.serving_temp_max, w.serving_temp_max),
    serving_temp_label = coalesce(u.serving_temp_label, w.serving_temp_label),
    decant_minutes = coalesce(u.decant_minutes, w.decant_minutes),
    enrichment_metadata = coalesce(u.enrichment_metadata, w.enrichment_metadata),
    last_enriched_at = now()
  from u
  where w.id = u.id
    and w.restaurant_id = p_restaurant_id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$func$;

comment on function public.enrich_wines_batch(uuid, jsonb) is
  'TER-026: manager-authorized, tenant-bound batch enrichment with manual-override gating.';

revoke all on function public.enrich_wines_batch(uuid, jsonb) from public;
revoke all on function public.enrich_wines_batch(uuid, jsonb) from anon;
grant execute on function public.enrich_wines_batch(uuid, jsonb) to authenticated;

create or replace function public.update_wine_metadata_atomic(
  p_restaurant_id uuid,
  p_wine_id uuid,
  p_updates jsonb
) returns table (
  id uuid,
  producer text,
  name text,
  vintage integer,
  varietal text,
  region text,
  tasting_notes text,
  drink_window_start integer,
  drink_window_end integer,
  peak_year smallint,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wine public.wines%rowtype;
  v_manual_fields text[] := '{}'::text[];
  v_start integer;
  v_end integer;
  v_peak integer;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;
  if p_restaurant_id is null or p_wine_id is null
     or p_updates is null or jsonb_typeof(p_updates) <> 'object'
     or p_updates = '{}'::jsonb then
    raise exception using errcode = '22023', message = 'invalid wine metadata input';
  end if;
  if not public.is_member_with_role(p_restaurant_id, 'manager') then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if exists (
    select 1
    from jsonb_object_keys(p_updates) as key
    where key <> all(array[
      'producer', 'name', 'vintage', 'varietal', 'region', 'tasting_notes',
      'drink_window_start', 'drink_window_end', 'peak_year'
    ]::text[])
  ) then
    raise exception using errcode = '22023', message = 'unsupported wine metadata field';
  end if;

  if p_updates ? 'producer' and (
    jsonb_typeof(p_updates->'producer') <> 'string'
    or p_updates->>'producer' <> btrim(p_updates->>'producer')
    or char_length(p_updates->>'producer') not between 1 and 255
  ) then
    raise exception using errcode = '22023', message = 'invalid producer';
  end if;
  if p_updates ? 'name' and (
    jsonb_typeof(p_updates->'name') <> 'string'
    or p_updates->>'name' <> btrim(p_updates->>'name')
    or char_length(p_updates->>'name') not between 1 and 255
  ) then
    raise exception using errcode = '22023', message = 'invalid wine name';
  end if;
  if p_updates ? 'vintage'
     and p_updates->'vintage' <> 'null'::jsonb
     and (
       jsonb_typeof(p_updates->'vintage') <> 'number'
       or (p_updates->>'vintage')::numeric <> trunc((p_updates->>'vintage')::numeric)
       or (p_updates->>'vintage')::numeric not between 1900 and 2100
     ) then
    raise exception using errcode = '22023', message = 'invalid vintage';
  end if;
  if p_updates ? 'varietal'
     and p_updates->'varietal' <> 'null'::jsonb
     and (
       jsonb_typeof(p_updates->'varietal') <> 'string'
       or p_updates->>'varietal' <> btrim(p_updates->>'varietal')
       or char_length(p_updates->>'varietal') > 255
     ) then
    raise exception using errcode = '22023', message = 'invalid varietal';
  end if;
  if p_updates ? 'region'
     and p_updates->'region' <> 'null'::jsonb
     and (
       jsonb_typeof(p_updates->'region') <> 'string'
       or p_updates->>'region' <> btrim(p_updates->>'region')
       or char_length(p_updates->>'region') > 255
     ) then
    raise exception using errcode = '22023', message = 'invalid region';
  end if;
  if p_updates ? 'tasting_notes'
     and p_updates->'tasting_notes' <> 'null'::jsonb
     and (
       jsonb_typeof(p_updates->'tasting_notes') <> 'string'
       or p_updates->>'tasting_notes' <> btrim(p_updates->>'tasting_notes')
       or char_length(p_updates->>'tasting_notes') > 5000
     ) then
    raise exception using errcode = '22023', message = 'invalid tasting notes';
  end if;
  if p_updates ? 'drink_window_start'
     and p_updates->'drink_window_start' <> 'null'::jsonb
     and (
       jsonb_typeof(p_updates->'drink_window_start') <> 'number'
       or (p_updates->>'drink_window_start')::numeric <> trunc((p_updates->>'drink_window_start')::numeric)
       or (p_updates->>'drink_window_start')::numeric not between 1900 and 2100
     ) then
    raise exception using errcode = '22023', message = 'invalid drink-window start';
  end if;
  if p_updates ? 'drink_window_end'
     and p_updates->'drink_window_end' <> 'null'::jsonb
     and (
       jsonb_typeof(p_updates->'drink_window_end') <> 'number'
       or (p_updates->>'drink_window_end')::numeric <> trunc((p_updates->>'drink_window_end')::numeric)
       or (p_updates->>'drink_window_end')::numeric not between 1900 and 2100
     ) then
    raise exception using errcode = '22023', message = 'invalid drink-window end';
  end if;
  if p_updates ? 'peak_year'
     and p_updates->'peak_year' <> 'null'::jsonb
     and (
       jsonb_typeof(p_updates->'peak_year') <> 'number'
       or (p_updates->>'peak_year')::numeric <> trunc((p_updates->>'peak_year')::numeric)
       or (p_updates->>'peak_year')::numeric not between 1900 and 2100
     ) then
    raise exception using errcode = '22023', message = 'invalid peak year';
  end if;

  select * into v_wine
  from public.wines
  where wines.id = p_wine_id
    and wines.restaurant_id = p_restaurant_id
  for update;
  if not found then
    return;
  end if;

  v_start := case
    when p_updates ? 'drink_window_start' then (p_updates->>'drink_window_start')::integer
    else v_wine.drink_window_start
  end;
  v_end := case
    when p_updates ? 'drink_window_end' then (p_updates->>'drink_window_end')::integer
    else v_wine.drink_window_end
  end;
  v_peak := case
    when p_updates ? 'peak_year' then (p_updates->>'peak_year')::integer
    else v_wine.peak_year
  end;
  if p_updates ? 'drink_window_start'
     or p_updates ? 'drink_window_end'
     or p_updates ? 'peak_year' then
    if v_start is not null and v_end is not null and v_start > v_end then
      raise exception using errcode = '22023', message = 'drink-window start must not be after its end';
    end if;
    if v_peak is not null
       and ((v_start is not null and v_peak < v_start)
         or (v_end is not null and v_peak > v_end)) then
      raise exception using errcode = '22023', message = 'peak year must fall within the drink window';
    end if;
  end if;

  if p_updates ? 'region' then
    v_manual_fields := array_append(v_manual_fields, 'region');
  end if;
  if p_updates ? 'varietal' then
    v_manual_fields := array_append(v_manual_fields, 'varietal');
  end if;
  if p_updates ? 'drink_window_start'
     or p_updates ? 'drink_window_end'
     or p_updates ? 'peak_year' then
    v_manual_fields := array_append(v_manual_fields, 'drink_window');
  end if;

  return query
  update public.wines as w
  set
    producer = case when p_updates ? 'producer' then p_updates->>'producer' else w.producer end,
    name = case when p_updates ? 'name' then p_updates->>'name' else w.name end,
    vintage = case when p_updates ? 'vintage' then (p_updates->>'vintage')::integer else w.vintage end,
    varietal = case when p_updates ? 'varietal' then p_updates->>'varietal' else w.varietal end,
    region = case when p_updates ? 'region' then p_updates->>'region' else w.region end,
    tasting_notes = case when p_updates ? 'tasting_notes' then p_updates->>'tasting_notes' else w.tasting_notes end,
    drink_window_start = v_start,
    drink_window_end = v_end,
    peak_year = v_peak,
    manual_overrides = array(
      select distinct field
      from unnest(coalesce(w.manual_overrides, '{}'::text[]) || v_manual_fields) as field
      order by field
    )
  where w.id = p_wine_id
    and w.restaurant_id = p_restaurant_id
  returning
    w.id,
    w.producer,
    w.name,
    w.vintage,
    w.varietal,
    w.region,
    w.tasting_notes,
    w.drink_window_start,
    w.drink_window_end,
    w.peak_year,
    w.updated_at;
end;
$$;

comment on function public.update_wine_metadata_atomic(uuid, uuid, jsonb) is
  'TER-026: tenant-bound manager metadata write that atomically records enrichment override locks.';

revoke all on function public.update_wine_metadata_atomic(uuid, uuid, jsonb) from public;
revoke all on function public.update_wine_metadata_atomic(uuid, uuid, jsonb) from anon;
grant execute on function public.update_wine_metadata_atomic(uuid, uuid, jsonb) to authenticated;
