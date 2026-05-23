-- Down migration for 0047_wines_decant_minutes
-- Restore enrich_wines_batch to version without decant_minutes

CREATE OR REPLACE FUNCTION public.enrich_wines_batch(
  p_restaurant_id uuid,
  p_enrichments   jsonb
) RETURNS int
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_count int;
BEGIN
  IF p_enrichments IS NULL OR jsonb_typeof(p_enrichments) <> 'array' OR jsonb_array_length(p_enrichments) = 0 THEN
    RETURN 0;
  END IF;

  WITH u AS (
    SELECT
      (e->>'id')::uuid                  AS id,
      (e->>'drink_window_start')::int    AS drink_window_start,
      (e->>'drink_window_end')::int      AS drink_window_end,
      (e->>'peak_year')::int             AS peak_year,
      (e->>'rating')::numeric            AS rating,
      (e->>'rating_source')              AS rating_source,
      (e->>'review_excerpt')             AS review_excerpt,
      (e->>'serving_temp_min')::int      AS serving_temp_min,
      (e->>'serving_temp_max')::int      AS serving_temp_max,
      (e->>'serving_temp_label')         AS serving_temp_label,
      (e->>'enrichment_metadata')::jsonb AS enrichment_metadata
    FROM jsonb_array_elements(p_enrichments) AS e
  )
  UPDATE public.wines w
  SET
    drink_window_start = coalesce(u.drink_window_start, w.drink_window_start),
    drink_window_end   = coalesce(u.drink_window_end,   w.drink_window_end),
    peak_year          = coalesce(u.peak_year,          w.peak_year),
    rating             = coalesce(u.rating,             w.rating),
    rating_source      = coalesce(u.rating_source,      w.rating_source),
    review_excerpt     = coalesce(u.review_excerpt,     w.review_excerpt),
    serving_temp_min   = coalesce(u.serving_temp_min,   w.serving_temp_min),
    serving_temp_max   = coalesce(u.serving_temp_max,   w.serving_temp_max),
    serving_temp_label = coalesce(u.serving_temp_label, w.serving_temp_label),
    enrichment_metadata = coalesce(u.enrichment_metadata, w.enrichment_metadata),
    last_enriched_at   = now()
  FROM u
  WHERE w.id = u.id
    AND w.restaurant_id = p_restaurant_id;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

ALTER TABLE wines DROP COLUMN decant_minutes;
