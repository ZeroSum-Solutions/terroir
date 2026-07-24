import { z } from "zod";
import { CELLAR_BATCH_SECTION_LIMIT } from "@/lib/cellar/batch-section";

export const AddCellarWineBodySchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    producer: z.string().trim().min(1).max(200),
    vintage: z.number().int().min(1900).max(2100).nullable().optional(),
    varietal: z.string().trim().max(100).nullable().optional(),
    region: z.string().trim().max(100).nullable().optional(),
    country: z.string().trim().max(100).nullable().optional(),
    quantity: z.number().int().min(1).max(100_000).default(1),
    unit_cost: z.number().min(0).max(99_999_999.99).optional(),
  })
  .strict();

export const BatchCellarSectionBodySchema = z
  .object({
    wine_ids: z
      .array(z.string().uuid())
      .min(1)
      .max(CELLAR_BATCH_SECTION_LIMIT),
    section: z.string().trim().min(1).max(100),
  })
  .strict()
  .superRefine((body, context) => {
    if (new Set(body.wine_ids).size !== body.wine_ids.length) {
      context.addIssue({
        code: "custom",
        message: "wine_ids must not contain duplicates.",
        path: ["wine_ids"],
      });
    }
  });

export const CellarInventoryResultSchema = z.object({
  id: z.string().uuid(),
  quantity: z.number().int().min(0),
  unit_cost: z.number().min(0),
});
