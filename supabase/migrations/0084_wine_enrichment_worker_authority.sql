-- TER-021G: allow only the durable service-role worker to reuse the existing
-- tenant-bound LWIN and enrichment RPCs. Authenticated web callers retain the
-- owner/manager checks installed by TER-026.

create or replace function public.match_lwin_batch(
  p_restaurant_id uuid,
  p_wine_ids uuid[]
)
returns table (wine_id uuid, lwin_id text, score float)
language plpgsql
security definer
set search_path = ''
as $$
declare
  w record;
  m record;
begin
  if auth.role() <> 'service_role'
     and not public.is_member_with_role(p_restaurant_id, 'staff') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if exists (
    select 1
    from unnest(p_wine_ids) requested(wine_id)
    left join public.wines
      on wines.id = requested.wine_id
      and wines.restaurant_id = p_restaurant_id
    where wines.id is null
  ) then
    raise exception 'wine not found' using errcode = 'P0001';
  end if;

  for w in
    select
      wines.id,
      wines.producer,
      wines.name,
      wines.country,
      wines.region,
      wines.varietal
    from public.wines
    where wines.restaurant_id = p_restaurant_id
      and wines.id = any(p_wine_ids)
      and wines.lwin_id is null
  loop
    select * into m from public.match_lwin(w.producer, w.name);
    if m.lwin_id is not null then
      update public.wines
      set lwin_id = m.lwin_id,
          country = coalesce(wines.country, m.country),
          region = coalesce(wines.region, m.region),
          varietal = coalesce(wines.varietal, m.varietal)
      where id = w.id
        and restaurant_id = p_restaurant_id;

      wine_id := w.id;
      lwin_id := m.lwin_id;
      score := m.score;
      return next;
    end if;
  end loop;
end;
$$;

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
  if auth.role() <> 'service_role' then
    if auth.uid() is null then
      raise exception using errcode = '42501', message = 'authentication required';
    end if;
    if not public.is_member_with_role(p_restaurant_id, 'manager') then
      raise exception using errcode = '42501', message = 'forbidden';
    end if;
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
  'TER-021G: manager-authorized web enrichment or service-role worker enrichment, always tenant-bound and manual-override-safe.';

revoke all on function public.match_lwin(text, text, float)
  from public, anon, service_role;
grant execute on function public.match_lwin(text, text, float)
  to authenticated, service_role;
revoke all on function public.match_lwin_batch(uuid, uuid[])
  from public, anon, service_role;
grant execute on function public.match_lwin_batch(uuid, uuid[])
  to authenticated, service_role;
revoke all on function public.enrich_wines_batch(uuid, jsonb)
  from public, anon, service_role;
grant execute on function public.enrich_wines_batch(uuid, jsonb)
  to authenticated, service_role;
