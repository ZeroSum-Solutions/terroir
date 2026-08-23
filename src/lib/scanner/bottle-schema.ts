import { z } from "zod";

/** Identity-sensitive fields eligible for low-confidence flagging. */
export const BottleFieldSchema = z.enum([
  "producer",
  "name",
  "vintage",
  "region",
  "format",
]);

/**
 * One ranked wine-identification candidate. The server maps this 1:1 onto
 * `BottleCandidate` (src/lib/scanner/types.ts) after validation.
 */
export const ParsedBottleCandidateSchema = z.object({
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
  format: z
    .string()
    .nullable()
    .describe(
      "Bottle format/size if printed or clearly depicted (e.g. '750ml', 'Magnum (1.5L)', 'Half bottle (375ml)'). Null if not visible — never assume a standard size.",
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "Self-assessed confidence from 0.0 to 1.0 for THIS candidate. Use 0.95+ for clearly readable labels, lower for obscured, angled, or partial labels.",
    ),
  lowFields: z
    .array(BottleFieldSchema)
    .describe(
      "Identity-sensitive fields (producer, name, vintage, region, format) you are genuinely uncertain about for this candidate. Empty array if all are confidently read.",
    ),
  notes: z
    .string()
    .nullable()
    .describe(
      "Anything notable: back-label details, alcohol percentage, special designations (Grand Cru, Reserva, etc.), or fields you could not read. Null if nothing to note.",
    ),
});

export type ParsedBottleCandidate = z.infer<typeof ParsedBottleCandidateSchema>;

/**
 * Schema Claude returns when identifying a wine from a bottle label photo:
 * 1-3 ranked candidates, best first. The server maps `candidates` onto the
 * `BottleScanResult` shape consumed by the UI, adding a timestamp.
 */
export const ParsedBottleLabelSchema = z.object({
  candidates: z
    .array(ParsedBottleCandidateSchema)
    .min(1)
    .max(3)
    .describe(
      "1 to 3 ranked candidate identifications, best match first. Return more than 1 only when the label is genuinely ambiguous (e.g. a smudged vintage, a producer that could be one of a few similarly-labeled wines).",
    ),
});

export type ParsedBottleLabel = z.infer<typeof ParsedBottleLabelSchema>;
