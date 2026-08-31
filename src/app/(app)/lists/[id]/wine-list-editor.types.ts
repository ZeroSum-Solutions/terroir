/**
 * Row shapes the wine-list editor renders.
 *
 * Split out of `wine-list-editor.tsx` so `use-add-wine.ts` can build a
 * full-shape optimistic row without importing the component module back into
 * itself. Re-exported from `wine-list-editor.tsx` so every existing import
 * site keeps working.
 */

export type WineListEditorWine = {
  id: string;
  name: string;
  producer: string;
  vintage: number | null;
  varietal: string | null;
  region: string | null;
  drink_window_start?: number | null;
  drink_window_end?: number | null;
  serving_temp_min?: number | null;
  serving_temp_max?: number | null;
  serving_temp_label?: string | null;
  /** Read by the row's thumbnail; present on the server payload already. */
  colour?: string | null;
  hero_image_url?: string | null;
};

export type WineListEditorItem = {
  id: string;
  section_id: string;
  wine_id: string;
  position: number;
  glass_price: number | null;
  bottle_price: number | null;
  glass_pour_ml: number | null;
  pour_size_mode: "fixed" | "picker";
  tasting_note: string | null;
  name_override: string | null;
  blurb: string | null;
  hidden: boolean;
  /**
   * LIST-03 — the price the app suggests when the stored one is null, with the
   * settings markup / pour-cost rule already applied. Null only when no
   * suggestion can be computed (no retail data for the wine).
   */
  suggested_glass_price?: number | null;
  suggested_bottle_price?: number | null;
  wines: WineListEditorWine;
};

export type WineListEditorSection = {
  id: string;
  name: string;
  position: number;
  wine_list_id: string;
  wine_list_items: WineListEditorItem[];
};
