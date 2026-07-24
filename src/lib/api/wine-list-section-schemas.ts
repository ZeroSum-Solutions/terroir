import { z } from "zod";

export const WineListSectionIdParamsSchema = z.object({
  id: z.string().uuid("id must be a valid UUID"),
});

export const CreateWineListSectionBodySchema = z
  .object({
    wine_list_id: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
  })
  .strict();

export const RenameWineListSectionBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
  })
  .strict();

export const ReorderWineListSectionsBodySchema = z
  .object({
    orderedIds: z
      .array(z.string().uuid())
      .min(1)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "orderedIds must not contain duplicates.",
      }),
  })
  .strict();
