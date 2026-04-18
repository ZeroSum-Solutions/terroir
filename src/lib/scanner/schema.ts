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
