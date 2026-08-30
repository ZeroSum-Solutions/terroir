/**
 * Wire shapes for the add-wine modal — the three response bodies it reads.
 *
 * Kept beside the component rather than inside it so the modal file stays
 * under the size ratchet, following the same split the import domain uses
 * (`batch-api-types.ts`, `review-types.ts`, `chunked-upload-types.ts`).
 */

/** BND-040 — response from `/api/wines/[id]/pricing-suggestion`. */
export type PricingSuggestion = {
  wineId: string;
  suggestedBottle: number | null;
  suggestedGlass: number | null;
  glassPourMl: number;
  targetMarkupRatio: number;
  targetPourCostPct: number;
  retailMedian: number | null;
  retailMin: number | null;
  retailMax: number | null;
  retailRetailerCount: number | null;
  retailRefreshedAt: string | null;
  categoryBandApplied: boolean;
  hasRetailData: boolean;
};

/** A wine already in this tenant's inventory, from `/api/wines/search`. */
export type SearchWine = {
  id: string;
  name: string;
  producer: string;
  vintage: number | null;
  varietal: string | null;
  region: string | null;
  /** Drives LIST-02's section pre-selection; null until enrichment runs. */
  colour: string | null;
  hero_image_url: string | null;
};

/** A catalog row from the LWIN reference data, not yet a tenant wine. */
export type LwinWine = {
  lwin_id: string;
  display_name: string;
  producer: string | null;
  varietal: string | null;
  region: string | null;
  country: string | null;
};
