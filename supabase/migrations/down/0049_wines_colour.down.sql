-- Down migration for 0049_wines_colour
-- Restore enrich_wines_batch to 0048 version (without colour)

create or replace function public.enrich_wines_batch(
  p_restaurant_id uuid,
  p_enrichments   jsonb
) returns int
language plpgsql
security invoker
as $func$
declare
  v_count int;
begin
  if p_enrichments is null or jsonb_typeof(p_enrichments) <> 'array' or jsonb_array_length(p_enrichments) = 0 then
    return 0;
  end if;

  with u as (
    select
      (e->>'id')::uuid                  as id,
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
      (e->>'enrichment_metadata')::jsonb as enrichment_metadata
    from jsonb_array_elements(p_enrichments) as e
  )
  update public.wines w
  set
    drink_window_start = case
      when 'drink_window' = any(w.manual_overrides) then w.drink_window_start
      else coalesce(u.drink_window_start, w.drink_window_start)
    end,
    drink_window_end   = case
      when 'drink_window' = any(w.manual_overrides) then w.drink_window_end
      else coalesce(u.drink_window_end, w.drink_window_end)
    end,
    peak_year          = case
      when 'drink_window' = any(w.manual_overrides) then w.peak_year
      else coalesce(u.peak_year, w.peak_year)
    end,
    region             = case
      when 'region' = any(w.manual_overrides) then w.region
      else coalesce(u.region, w.region)
    end,
    country            = case
      when 'country' = any(w.manual_overrides) then w.country
      else coalesce(u.country, w.country)
    end,
    varietal           = case
      when 'varietal' = any(w.manual_overrides) then w.varietal
      else coalesce(u.varietal, w.varietal)
    end,
    rating             = coalesce(u.rating,             w.rating),
    rating_source      = coalesce(u.rating_source,      w.rating_source),
    review_excerpt     = coalesce(u.review_excerpt,     w.review_excerpt),
    serving_temp_min   = coalesce(u.serving_temp_min,   w.serving_temp_min),
    serving_temp_max   = coalesce(u.serving_temp_max,   w.serving_temp_max),
    serving_temp_label = coalesce(u.serving_temp_label, w.serving_temp_label),
    decant_minutes     = coalesce(u.decant_minutes,     w.decant_minutes),
    enrichment_metadata = coalesce(u.enrichment_metadata, w.enrichment_metadata),
    last_enriched_at   = now()
  from u
  where w.id = u.id
    and w.restaurant_id = p_restaurant_id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$func$;

comment on function public.enrich_wines_batch(uuid, jsonb) is
  'BND-031/BND-039/BND-070/BND-277/BND-278: atomic batch enrichment with manual-override gating.';

ALTER TABLE public.wines DROP COLUMN colour;
