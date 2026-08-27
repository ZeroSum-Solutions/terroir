import { z } from "zod";
import { CANONICAL_HEADERS, MAX_FIELD_LENGTH, MAX_ROWS, type CanonicalHeader } from "./constants";

export const BatchIdParamsSchema = z.object({ id: z.string().uuid() });

export const BatchRowParamsSchema = z.object({
  id: z.string().uuid(),
  rowId: z.string().uuid(),
});

export const ResolveRowBodySchema = z.object({
  action: z.enum(["include", "exclude"]),
  manualUnitCost: z.number().min(0).max(1_000_000).optional(),
});

// Bulk resolution deliberately has no manualUnitCost: `include` only ever
// covers cost-present rows (see bulkResolveImportBatchRows) — a missing
// cost always goes through the per-row path with an explicit value.
export const BulkResolveBodySchema = z.object({
  action: z.enum(["include", "exclude"]),
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

// Inline row-fix overrides (confirm-time only — see ConfirmBatchOptions.
// rowOverrides in batch-service.ts). One row's worth of field overrides:
// keys are restricted to the exact CANONICAL_HEADERS whitelist via
// .strict() (any other key fails validation, not silently dropped), and
// every value is length-bounded the same as a real CSV cell
// (MAX_FIELD_LENGTH, csv-parser.ts's own per-cell cap) so an override
// can't smuggle in a pathologically large value a real upload never
// could.
const RowOverrideFieldsSchema = z
  .object(
    Object.fromEntries(
      CANONICAL_HEADERS.map((field) => [field, z.string().max(MAX_FIELD_LENGTH)]),
    ) as Record<CanonicalHeader, z.ZodString>,
  )
  .partial()
  .strict();

// Row indexes are the 1-indexed data row number the operator saw in that
// SAME file's own preview (see preview-service.ts's RowOverrides) — bounds
// here are the static ceiling MAX_ROWS already imposes on any file; the
// exact "does this row exist in THIS upload" check is necessarily dynamic
// (parsed row count isn't known until the file is read) and happens in
// buildImportPreview itself.
export const RowOverridesSchema = z
  .record(z.string().regex(/^\d+$/, "Row index must be a whole number."), RowOverrideFieldsSchema)
  .superRefine((obj, ctx) => {
    const keys = Object.keys(obj);
    if (keys.length > MAX_ROWS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Cannot override more than ${MAX_ROWS} rows.` });
      return;
    }
    for (const key of keys) {
      const n = Number(key);
      if (!Number.isSafeInteger(n) || n < 1 || n > MAX_ROWS) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Row index ${key} is out of bounds.`, path: [key] });
      }
    }
  });

// rowOverrides arrives as a JSON-string multipart field (every multipart
// form value is a string) — parsed then piped through RowOverridesSchema
// in one step so a malformed field fails with the same Zod-validation
// error shape every other request boundary in this codebase uses. The
// pre-parse length cap is a generous structural ceiling against a
// pathological JSON blob; the real per-row/per-field/per-value bounds are
// enforced by the piped schema above.
export const RowOverridesFieldSchema = z
  .string()
  .max(1_000_000)
  .optional()
  .transform((val, ctx) => {
    if (val === undefined) return undefined;
    try {
      return JSON.parse(val) as unknown;
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "rowOverrides must be valid JSON." });
      return z.NEVER;
    }
  })
  .pipe(RowOverridesSchema.optional());
