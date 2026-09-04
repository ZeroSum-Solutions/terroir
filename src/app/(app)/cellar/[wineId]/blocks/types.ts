/**
 * The wine row shape the detail blocks read. Lives here rather than in
 * wine-detail-view.tsx so the blocks can import it without importing their
 * own parent.
 *
 * `rating`, `rating_source`, `review_excerpt` and `tasting_notes` are gone
 * from this shape on purpose. The first three were the invented values the
 * page rebuild retires (spec §4.7) — the byline used to print the
 * fabrication's own name under its number — and the last was migrated into
 * the house corpus (0149). Nothing on this page reads a wine-row number
 * without a basis any more.
 */
export type WineRow = {
  id: string;
  name: string;
  producer: string;
  vintage: number | null;
  size_ml: number | null;
  colour: string | null;
  hero_image_url: string | null;
  is_eightysixed: boolean;
  retail_min: number | null;
  retail_max: number | null;
  retail_median: number | null;
  retail_retailer_count: number | null;
};
