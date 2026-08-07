import { z } from "zod";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1_000;

function pagination(defaultLimit = DEFAULT_LIMIT) {
  const integer = (fallback: number, min: number, max: number) =>
    z
      .union([z.undefined(), z.string().trim().regex(/^\d+$/)])
      .transform((value) => (value === undefined ? fallback : Number(value)))
      .pipe(z.number().int().min(min).max(max));

  return {
    limit: integer(defaultLimit, 1, MAX_LIMIT),
    offset: integer(0, 0, Number.MAX_SAFE_INTEGER - MAX_LIMIT),
  };
}

const filterText = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
    message: "Filter text contains unsupported control characters.",
  });

export const WineCollectionQuerySchema = z
  .object({
    ...pagination(),
    q: filterText.optional(),
    varietal: filterText.optional(),
    region: filterText.optional(),
    is_eightysixed: z.enum(["true", "false"]).optional(),
  })
  .strict();

export const ScanCollectionQuerySchema = z
  .object({
    ...pagination(),
    status: z.enum(["complete", "processing", "failed"]).optional(),
  })
  .strict();

export const WineListSectionsQuerySchema = z
  .object({ wine_list_id: z.string().uuid() })
  .strict();

export const WineListItemsQuerySchema = z
  .object({ section_id: z.string().uuid() })
  .strict();
