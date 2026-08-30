/**
 * The bin-grid payload shape, in one place.
 *
 * This type was declared independently in `page.tsx` (which builds it),
 * `cellar-shell.tsx` (which passes it through), and `cellar-grid.tsx` (which
 * renders it). Adding a field meant editing three identical declarations and
 * finding out from the compiler when one was missed — which is exactly what
 * happened when CELLAR-08 added the bottle image.
 */

export type BinWine = {
  wineId: string;
  name: string;
  producer: string;
  vintage: number | null;
  quantity: number;
  /** CELLAR-08 — so a bin card can show which bottle it means. */
  heroImageUrl: string | null;
  colour: string | null;
};

export type BinData = {
  wines: BinWine[];
  totalBottles: number;
};

/** Keyed by bin code, uppercased and trimmed ("A5"). */
export type GridData = Record<string, BinData>;
