/**
 * Canonical list of LineItem fields that count toward scan accuracy.
 *
 * Accuracy is computed as `1 - (editedFieldCount / (itemCount * SCORED_FIELDS_COUNT))`.
 * Adding or removing a field here automatically updates the denominator
 * in every caller (save-scan/route.ts, scanner.tsx, results-view.tsx).
 *
 * BND-022 — previously defined inline in save-scan/route.ts and
 * duplicated as the magic literal `7` in two client-side sites.
 */
import type { LineItem } from "./types";

export const SCORED_FIELDS: ReadonlyArray<keyof LineItem> = [
  "name",
  "producer",
  "vintage",
  "varietal",
  "region",
  "qty",
  "unitCost",
] as const;

export const SCORED_FIELDS_COUNT = SCORED_FIELDS.length;
