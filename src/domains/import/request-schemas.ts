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

// P3 (2026-08-23-p3-chunked-import.md §3) — multi-batch onboarding session
// schemas. Confirm's session fields arrive as multipart form fields
// (strings) alongside the file, so numeric ones use z.coerce.

export const SessionIdParamsSchema = z.object({ id: z.string().uuid() });

export const CreateSessionBodySchema = z.object({
  label: z.string().trim().min(1).max(200).optional(),
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
  declaredChunkTotal: z.coerce.number().int().positive().optional(),
});

export const ConfirmBatchSessionFieldsSchema = z.object({
  sessionId: z.string().uuid().optional(),
  chunkIndex: z.coerce.number().int().positive().optional(),
  chunkTotal: z.coerce.number().int().positive().optional(),
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
});
