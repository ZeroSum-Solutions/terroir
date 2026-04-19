import { z } from "zod";

/**
 * Schema Claude returns when identifying a wine from a bottle label photo.
 * The server adds a timestamp after validation to produce the full
 * `BottleScanResult` shape consumed by the UI.
 */
export const ParsedBottleLabelSchema = z.object({
  name: z.string().describe(
    "Wine name as printed on the label. Include cuvée, appellation, or vineyard designation if visible.",
  ),
  producer: z.string().describe(
    "Producer, domaine, or winery name. Preserve accents and original spelling (e.g., 'Château Margaux', 'Domaine Leflaive').",
  ),
  vintage: z
    .number()
    .int()
    .nullable()
    .describe(
      "Four-digit vintage year if printed on the label. Use null for non-vintage (NV) wines such as most Champagnes.",
    ),
  varietal: z.string().describe(
    "Grape varietal or blend (e.g., 'Chardonnay', 'Pinot Noir', 'Bordeaux Blend'). Infer from the wine name, region, or appellation if not explicitly on the label.",
  ),
  region: z.string().describe(
    "Wine region, not country (e.g., 'Burgundy', 'Barossa Valley', 'Willamette Valley').",
  ),
  country: z
    .string()
    .nullable()
    .describe(
      "Country of origin if identifiable from the label or inferable from the region. Null if uncertain.",
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "Self-assessed confidence from 0.0 to 1.0. Use 0.95+ for clearly readable labels, lower for obscured, angled, or partial labels.",
    ),
  notes: z
    .string()
    .nullable()
    .describe(
      "Anything notable: back-label details, alcohol percentage, special designations (Grand Cru, Reserva, etc.), or fields you could not read. Null if nothing to note.",
    ),
});

export type ParsedBottleLabel = z.infer<typeof ParsedBottleLabelSchema>;
