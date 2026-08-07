import { z } from "zod";

/**
 * Schema Claude returns when parsing a wine invoice. The server adds
 * generated IDs + timestamps after validation to produce the full
 * `Scan` shape consumed by the UI.
 */

export const LineItemFieldSchema = z.enum([
  "name",
  "producer",
  "vintage",
  "varietal",
  "region",
  "qty",
  "unitCost",
  "currency",
  "format",
]);

export const ParsedLineItemSchema = z.object({
  name: z.string().describe(
    "Wine name exactly as printed on the invoice. Include cuvée, appellation, or vineyard if listed.",
  ),
  producer: z.string().describe(
    "Producer or domaine name (e.g., 'Domaine Leflaive', 'Giuseppe Quintarelli'). Preserve accents and original spelling.",
  ),
  vintage: z
    .number()
    .int()
    .nullable()
    .describe(
      "Four-digit vintage year if printed. Use null for non-vintage (NV) wines such as most Champagnes.",
    ),
  varietal: z.string().describe(
    "Grape varietal or blend (e.g., 'Chardonnay', 'Cabernet Sauvignon', 'Bordeaux Blend'). Infer from the wine name + region if not explicitly printed.",
  ),
  region: z.string().describe(
    "Wine region, not country (e.g., 'Burgundy', 'Piedmont', 'Santa Cruz Mountains', 'Mosel').",
  ),
  qty: z
    .number()
    .int()
    .describe("Quantity of bottles ordered on this line."),
  unitCost: z
    .number()
    .describe(
      "Unit cost per bottle in US dollars. Numeric only, no currency symbol. If the invoice prints a European comma decimal, convert to a period.",
    ),
  currency: z
    .string()
    .nullable()
    .describe(
      "3-letter ISO currency code (e.g., USD, EUR, GBP). Default to USD if not specified. Use null if ambiguous.",
    ),
  format: z
    .string()
    .nullable()
    .describe(
      "Bottle size (e.g., 750ml, 1.5L, 375ml, 3L). Default to 750ml if not specified. Use null if the invoice does not indicate a bottle size.",
    ),
  confidence: z
    .number()
    .describe(
      "Self-assessed confidence from 0.0 to 1.0. Use <0.75 when the invoice is unclear, handwritten, ambiguous, or you had to guess a field.",
    ),
  lowFields: z
    .array(LineItemFieldSchema)
    .describe(
      "Field names you are uncertain about on this line. Omit fields you are confident in. Common examples: 'vintage' when the year is partially obscured, 'unitCost' when a digit is ambiguous.",
    ),
});

export const ParsedInvoiceSchema = z.object({
  distributor: z.string().describe(
    "Distributor or merchant name from the invoice header (e.g., 'Kermit Lynch Merchant', 'Southern Glazer's Wine & Spirits').",
  ),
  invoiceNumber: z
    .string()
    .nullable()
    .describe("Invoice number if printed (e.g., 'KL-48219'), else null."),
  invoiceDate: z
    .string()
    .nullable()
    .describe(
      "Invoice date as printed (e.g., 'Apr 15, 2026' or '2026-04-15'). Null if not visible.",
    ),
  lineItems: z.array(ParsedLineItemSchema).describe(
    "All wine line items on the invoice. Skip non-wine lines (shipping, tax, totals, gift cards).",
  ),
});

export type ParsedInvoice = z.infer<typeof ParsedInvoiceSchema>;
export type ParsedLineItem = z.infer<typeof ParsedLineItemSchema>;

/**
 * Persisted-scan envelope (BND-024 / ARCH-010).
 *
 * In-flight Scan state is kept in localStorage so users who navigate
 * away mid-review don't lose their work. The raw shape of Scan is
 * subject to change, so we wrap it in a version envelope and validate
 * on load. Anything that fails the version match OR the Zod shape check
 * is dropped (and cleared from localStorage) rather than returned as-is.
 *
 * Bump PERSISTED_SCAN_VERSION whenever the inner `data` shape changes
 * incompatibly. The next load will detect the mismatch and drop the
 * stale state — acceptable because in-flight scans are ephemeral.
 */
export const PERSISTED_SCAN_VERSION = 2;

const PersistedLineItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  producer: z.string(),
  vintage: z.number().int().nullable(),
  varietal: z.string(),
  region: z.string(),
  qty: z.number(),
  unitCost: z.number(),
  currency: z.string().nullable(),
  format: z.string().nullable(),
  confidence: z.number(),
  lowFields: z.array(LineItemFieldSchema).optional(),
});

const PersistedScanQualitySchema = z.object({
  avgConfidence: z.number(),
  lowConfidenceItems: z.number(),
  totalItems: z.number(),
  manualFallbackTriggered: z.boolean(),
  reason: z.enum(["low_confidence", "too_few_items", "both"]).optional(),
});

export const PersistedScanSchema = z.object({
  version: z.literal(PERSISTED_SCAN_VERSION),
  data: z.object({
    source: z.object({
      distributor: z.string(),
      invoiceNo: z.string(),
      invoiceDate: z.string(),
      parsedAt: z.string(),
    }),
    items: z.array(PersistedLineItemSchema),
    edits: z.record(z.string(), z.literal(true)),
    quality: PersistedScanQualitySchema.optional(),
    reviewedLowConfidence: z.boolean().optional(),
  }),
});
