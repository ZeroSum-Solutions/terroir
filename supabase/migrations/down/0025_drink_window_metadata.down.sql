-- Down for 0025_drink_window_metadata.sql (BND-039).
--
-- Drops the metadata columns + snooze RPC + reverts the
-- enrich_wines_batch RPC to the 0014-era body (without the new
-- metadata fields). The drink_window_start/end columns predate this
-- migration and remain.

ALTER TABLE public.wines
  DROP COLUMN IF EXISTS peak_year,
  DROP COLUMN IF EXISTS rating,
  DROP COLUMN IF EXISTS rating_source,
  DROP COLUMN IF EXISTS review_excerpt,
  DROP COLUMN IF EXISTS last_enriched_at,
  DROP COLUMN IF EXISTS alert_snoozed_until;

DROP FUNCTION IF EXISTS public.snooze_drink_window_alert(uuid, int);

-- Revert enrich_wines_batch to its 0014 form (5 columns, no metadata,
-- no last_enriched_at write). This keeps existing 0014-shaped callers
-- working if rolled back.
create or replace function public.enrich_wines_batch(
  p_restaurant_id uuid,
  p_enrichments   jsonb
) returns int
language plpgsql
security invoker
as $$
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
      (e->>'serving_temp_min')::int      as serving_temp_min,
      (e->>'serving_temp_max')::int      as serving_temp_max,
      (e->>'serving_temp_label')         as serving_temp_label
    from jsonb_array_elements(p_enrichments) as e
  )
  update public.wines w
  set
    drink_window_start = u.drink_window_start,
    drink_window_end   = u.drink_window_end,
    serving_temp_min   = u.serving_temp_min,
    serving_temp_max   = u.serving_temp_max,
    serving_temp_label = u.serving_temp_label
  from u
  where w.id = u.id
    and w.restaurant_id = p_restaurant_id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.enrich_wines_batch(uuid, jsonb) is
  'BND-031: atomic batch enrichment of wines. Returns the number of rows updated.';
