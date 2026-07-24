import { z } from "zod";

export const WineIdParamsSchema = z.object({
  id: z.string().uuid("id must be a valid UUID"),
});

export const EditWineBodySchema = z
  .object({
    producer: z.string().trim().min(1).max(255).optional(),
    name: z.string().trim().min(1).max(255).optional(),
    vintage: z.number().int().min(1900).max(2100).nullable().optional(),
    varietal: z.string().trim().max(255).nullable().optional(),
    region: z.string().trim().max(255).nullable().optional(),
    tasting_notes: z.string().trim().max(5000).nullable().optional(),
    drink_window_start: z
      .number()
      .int()
      .min(1900)
      .max(2100)
      .nullable()
      .optional(),
    drink_window_end: z
      .number()
      .int()
      .min(1900)
      .max(2100)
      .nullable()
      .optional(),
    peak_year: z
      .number()
      .int()
      .min(1900)
      .max(2100)
      .nullable()
      .optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "No valid fields to update.",
  });

export const WineAvailabilityBodySchema = z
  .object({
    direction: z.enum(["eightysixed", "restored"]),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

export const AlertDaysBodySchema = z
  .object({
    days: z.number().int().min(0).max(365).optional(),
  })
  .strict()
  .default({});

export const PricingTargetsBodySchema = z
  .object({
    pour_cost_pct: z.number().gt(0).lt(100).nullable().optional(),
    markup_ratio: z.number().gte(1).lte(10).nullable().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "No valid fields.",
  });
