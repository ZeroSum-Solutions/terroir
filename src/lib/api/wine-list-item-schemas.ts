import { z } from "zod";

const PriceSchema = z.number().finite().nonnegative();

export const WineListItemIdParamsSchema = z.object({
  id: z.string().uuid("id must be a valid UUID"),
});

export const CreateWineListItemBodySchema = z
  .object({
    section_id: z.string().uuid(),
    wine_id: z.string().uuid(),
    glass_price: PriceSchema.nullable().optional(),
    bottle_price: PriceSchema.nullable().optional(),
    name_override: z.string().nullable().optional(),
  })
  .strict();

export const UpdateWineListItemBodySchema = z
  .object({
    glass_price: PriceSchema.nullable().optional(),
    bottle_price: PriceSchema.nullable().optional(),
    tasting_note: z.string().optional(),
    position: z.number().int().nonnegative().optional(),
    glass_pour_ml: z.number().int().positive().max(2000).nullable().optional(),
    pour_size_mode: z.enum(["fixed", "picker"]).optional(),
    name_override: z.string().nullable().optional(),
    blurb: z.string().nullable().optional(),
    hidden: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "No valid fields.",
  });

export const ReorderWineListItemsBodySchema = z
  .object({
    orderedIds: z
      .array(z.string().uuid())
      .min(1)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "orderedIds must not contain duplicates.",
      }),
  })
  .strict();
