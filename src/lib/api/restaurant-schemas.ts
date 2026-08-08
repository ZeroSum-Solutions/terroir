import { z } from "zod";

export const UpdateRestaurantBodySchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    auto_eightysix_from_inventory: z.boolean().optional(),
    eightysix_ml_threshold: z.number().int().min(0).max(5000).optional(),
    default_target_pour_cost_pct: z.number().gt(0).lt(100).optional(),
    default_target_markup_ratio: z.number().gte(1).lte(10).optional(),
    eightysix_strategy: z.enum(["hide", "mark"]).optional(),
  })
  .strict();
