import { z } from "zod";

const LineItemFieldSchema = z.enum([
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

export const InvoicePathBodySchema = z.object({
  imagePath: z.string().trim().min(1),
});

export const QrLookupBodySchema = z.object({
  qr_payload: z.string().uuid(),
});

export const ConfirmBottleBodySchema = z.object({
  wine_id: z.string().uuid("wine_id must be a valid UUID"),
  section: z.string().trim().min(1, "section is required").max(200),
  bin_location: z
    .string()
    .trim()
    .min(1, "bin_location is required")
    .max(200),
});

export const SaveBottleScanBodySchema = z.object({
  wine: z.object({
    name: z.string().trim().min(1),
    producer: z.string().trim().min(1),
    vintage: z.number().int().nullable(),
    varietal: z.string(),
    region: z.string(),
    country: z.string().nullable(),
    qty: z.number().int().positive(),
    unitCost: z.number().finite().nonnegative(),
  }),
});

export const ScanLineItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  producer: z.string(),
  vintage: z.number().int().nullable(),
  varietal: z.string(),
  region: z.string(),
  qty: z.number().int().positive(),
  unitCost: z.number().finite().nonnegative(),
  lineTotal: z.number().nullable().optional(),
  currency: z.string().nullable().optional(),
  format: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1),
  lowFields: z.array(LineItemFieldSchema).optional(),
});

export const ScanIdParamsSchema = z.object({
  id: z.string().uuid("id must be a valid UUID"),
});

export const ScanLineItemsSchema = z.array(ScanLineItemSchema).min(1);

export const UpdateScanBodySchema = z.object({
  items: ScanLineItemsSchema,
  edits: z.record(z.string(), z.literal(true)),
});

export const StoredOcrSchema = z.object({
  rawText: z.string().trim().min(1),
  vendorName: z.string().optional(),
  invoiceNumber: z.string().optional(),
  invoiceDate: z.string().optional(),
  tables: z
    .array(
      z.object({
        description: z.string(),
        quantity: z.number().nullable().optional(),
        unitPrice: z.number().nullable().optional(),
        amount: z.number().nullable().optional(),
      }),
    )
    .default([]),
});

const ScanSchema = z.object({
  source: z.object({
    distributor: z.string(),
    invoiceNo: z.string(),
    invoiceDate: z.string(),
    parsedAt: z.string(),
  }),
  items: z.array(ScanLineItemSchema).min(1),
  edits: z.record(z.string(), z.literal(true)),
  quality: z
    .object({
      avgConfidence: z.number(),
      lowConfidenceItems: z.number().int().nonnegative(),
      totalItems: z.number().int().nonnegative(),
      manualFallbackTriggered: z.boolean(),
      reason: z
        .enum(["low_confidence", "too_few_items", "both", "arithmetic_mismatch"])
        .optional(),
    })
    .optional(),
  rawText: z.string().optional(),
});

export const SaveInvoiceScanBodySchema = z.object({
  scan: ScanSchema,
  originalItems: z.array(ScanLineItemSchema),
});
