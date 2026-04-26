-- BND-039 — Drink window metadata (the drink-window intelligence feature).
--
-- Schema additions: enrichment provenance + alert snooze. drink_window_start
-- and drink_window_end already exist (since 0014 era).
--
-- All columns nullable so existing wines render gracefully without
-- enrichment data. The UI surfaces degrade — no panel rendered if
-- drink_window_end is null.
--
-- This migration was applied via the Supabase MCP `apply_migration`
-- on 2026-04-26 against project qcfmwphlaekfkqwkfyth (terroir prod).
-- The local file exists for git history + future regen reproducibility.
--
-- DOWN (manual):
--   ALTER TABLE public.wines
--     DROP COLUMN peak_year,
--     DROP COLUMN rating,
--     DROP COLUMN rating_source,
--     DROP COLUMN review_excerpt,
--     DROP COLUMN last_enriched_at,
--     DROP COLUMN alert_snoozed_until;
--   DROP FUNCTION IF EXISTS public.snooze_drink_window_alert(uuid, int);
--   (revert enrich_wines_batch by re-running 0014's body)

ALTER TABLE public.wines
  ADD COLUMN peak_year           smallint,
  ADD COLUMN rating              smallint,
  ADD COLUMN rating_source       text,
  ADD COLUMN review_excerpt      text,
  ADD COLUMN last_enriched_at    timestamptz,
  ADD COLUMN alert_snoozed_until timestamptz;

ALTER TABLE public.wines
  ADD CONSTRAINT wines_rating_range
    CHECK (rating IS NULL OR (rating >= 0 AND rating <= 100)),
  ADD CONSTRAINT wines_peak_year_range
    CHECK (peak_year IS NULL OR (peak_year >= 1900 AND peak_year <= 2100));

COMMENT ON COLUMN public.wines.rating_source IS
  'BND-039 provenance of enrichment data. Allowed: rule_engine | claude_inference | vinous | parker | js | wine_spectator | decanter | aggregate. Validated in app layer (not a DB enum so adding sources is migration-free).';

COMMENT ON COLUMN public.wines.alert_snoozed_until IS
  'BND-039: per-wine snooze for the Insights drink-window briefing alert. NULL = not snoozed. 30-day default set by /api/wines/[id]/snooze-alert.';

-- Update enrich_wines_batch RPC to accept the new fields. Backwards-compatible:
-- the jsonb payload may or may not include new keys; absent keys leave the
-- existing row value untouched (coalesce). Old callers keep working.

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
      (e->>'peak_year')::int             as peak_year,
      (e->>'rating')::int                as rating,
      (e->>'rating_source')              as rating_source,
      (e->>'review_excerpt')             as review_excerpt,
      (e->>'serving_temp_min')::int      as serving_temp_min,
      (e->>'serving_temp_max')::int      as serving_temp_max,
      (e->>'serving_temp_label')         as serving_temp_label
    from jsonb_array_elements(p_enrichments) as e
  )
  update public.wines w
  set
    drink_window_start = coalesce(u.drink_window_start, w.drink_window_start),
    drink_window_end   = coalesce(u.drink_window_end,   w.drink_window_end),
    peak_year          = coalesce(u.peak_year,          w.peak_year),
    rating             = coalesce(u.rating,             w.rating),
    rating_source      = coalesce(u.rating_source,      w.rating_source),
    review_excerpt     = coalesce(u.review_excerpt,     w.review_excerpt),
    serving_temp_min   = coalesce(u.serving_temp_min,   w.serving_temp_min),
    serving_temp_max   = coalesce(u.serving_temp_max,   w.serving_temp_max),
    serving_temp_label = coalesce(u.serving_temp_label, w.serving_temp_label),
    last_enriched_at   = now()
  from u
  where w.id = u.id
    and w.restaurant_id = p_restaurant_id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.enrich_wines_batch(uuid, jsonb) is
  'BND-031 + BND-039: atomic batch enrichment of wines including drink window, serving temp, and rating metadata. Returns the number of rows updated.';

-- Snooze alert RPC — separate from enrich_wines_batch because it has
-- different auth gating (owner+manager only, matched via app-level
-- requireMembership; not enforced via trigger because it's a low-stakes
-- UX state, not security-critical).

create or replace function public.snooze_drink_window_alert(
  p_wine_id uuid,
  p_days    int default 30
) returns timestamptz
language plpgsql
security invoker
as $$
declare
  v_until timestamptz;
begin
  v_until := now() + make_interval(days => p_days);

  update public.wines
  set alert_snoozed_until = v_until
  where id = p_wine_id;

  if not found then
    raise exception 'wine not found' using errcode = 'P0002';
  end if;

  return v_until;
end;
$$;

comment on function public.snooze_drink_window_alert(uuid, int) is
  'BND-039: snooze the drink-window alert for a wine. Default 30 days. Owner+manager gating enforced at the API layer via requireMembership.';
