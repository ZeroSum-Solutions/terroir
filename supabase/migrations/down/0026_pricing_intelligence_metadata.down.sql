-- Down for 0026_pricing_intelligence_metadata.sql (BND-040).
--
-- Drops:
--   • Pricing target columns on restaurants
--   • Pricing target / retail cache / dismissal columns on wines
--   • Index on (restaurant_id, retail_refreshed_at)
--   • dismiss_pricing_alert RPC
--
-- Does NOT roll back the 0025-era changes to enrich_wines_batch — those
-- are handled by 0025's own down script. This file is strictly the
-- inverse of 0026 forward.

ALTER TABLE public.restaurants
  DROP COLUMN IF EXISTS default_target_pour_cost_pct,
  DROP COLUMN IF EXISTS default_target_markup_ratio;

ALTER TABLE public.wines
  DROP COLUMN IF EXISTS pricing_target_pour_cost_pct,
  DROP COLUMN IF EXISTS pricing_target_markup_ratio,
  DROP COLUMN IF EXISTS pricing_dismissed_until,
  DROP COLUMN IF EXISTS retail_min,
  DROP COLUMN IF EXISTS retail_max,
  DROP COLUMN IF EXISTS retail_median,
  DROP COLUMN IF EXISTS retail_retailer_count,
  DROP COLUMN IF EXISTS retail_refreshed_at;

DROP INDEX IF EXISTS public.wines_retail_refreshed_at_idx;

DROP FUNCTION IF EXISTS public.dismiss_pricing_alert(uuid, int);
