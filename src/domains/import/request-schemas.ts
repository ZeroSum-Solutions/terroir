import { z } from "zod";

export const BatchIdParamsSchema = z.object({ id: z.string().uuid() });

export const BatchRowParamsSchema = z.object({
  id: z.string().uuid(),
  rowId: z.string().uuid(),
});

export const ResolveRowBodySchema = z.object({
  action: z.enum(["include", "exclude"]),
  manualUnitCost: z.number().min(0).max(1_000_000).optional(),
});
