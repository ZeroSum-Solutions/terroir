/**
 * The wine row shape the detail blocks read. Lives here rather than in
 * wine-detail-view.tsx so the blocks can import it without importing their
 * own parent.
 */
export type WineRow = {
  id: string;
  name: string;
  producer: string;
  vintage: number | null;
  size_ml: number | null;
  colour: string | null;
  hero_image_url: string | null;
  tasting_notes: string | null;
  is_eightysixed: boolean;
  retail_min: number | null;
  retail_max: number | null;
  retail_median: number | null;
  retail_retailer_count: number | null;
  rating: number | null;
  rating_source: string | null;
  review_excerpt: string | null;
};
