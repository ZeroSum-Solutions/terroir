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

// Sol audit (2026-08-27) finding 4: this is a BACKSTOP only, deliberately
// far above MAX_FIELD_LENGTH — the real boundary for an over-length
// override is validateFields (row-validator.ts), shared by both the
// client's live re-validation and the server's own confirm path, which
// turns it into a normal per-row field error instead of failing the whole
// request. Capping this schema AT MAX_FIELD_LENGTH would defeat that: any
// realistic over-length paste would 400 the entire request here, before
// validateFields ever got a chance to reject just that one row. This only
// exists to reject a truly pathological single value (megabytes in one
// field) outright.
const OVERRIDE_FIELD_HARD_CAP = MAX_FIELD_LENGTH * 10;

// Inline row-fix overrides (confirm-time only — see ConfirmBatchOptions.
// rowOverrides in batch-service.ts). One row's worth of field overrides:
// keys are restricted to the exact CANONICAL_HEADERS whitelist via
// .strict() (any other key fails validation, not silently dropped), and
// every value is bounded by OVERRIDE_FIELD_HARD_CAP above — the real
// MAX_FIELD_LENGTH boundary lives in validateFields, see its comment.
const RowOverrideFieldsSchema = z
  .object(
    Object.fromEntries(
      CANONICAL_HEADERS.map((field) => [field, z.string().max(OVERRIDE_FIELD_HARD_CAP)]),
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
//
// Sol audit (2026-08-27) finding 3: the key pattern is the CANONICAL
// positive-integer form only — no leading zeros ("01", "0") — because
// preview-service.ts/batch-service.ts key their own lookups by
// String(rowNumber) (e.g. String(1) === "1", never "01"), so a
// leading-zero key would silently never match any real row instead of
// erroring. "0" itself is excluded the same way (row numbers are
// 1-indexed).
export const RowOverridesSchema = z
  .record(z.string().regex(/^[1-9][0-9]*$/, "Row index must be a canonical positive whole number (no leading zeros)."), RowOverrideFieldsSchema)
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(val);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "rowOverrides must be valid JSON." });
      return z.NEVER;
    }
    // Sol audit (2026-08-27) finding 3: a "__proto__" key parses to a
    // genuine OWN data property here (JSON.parse never triggers the
    // prototype-setter — this isn't prototype pollution), but zod's own
    // z.record() silently drops it rather than rejecting it, so
    // `{"__proto__": {...}}` would otherwise reduce to `{}` with no error
    // at all — an operator's edit vanishing with no signal. Checked here,
    // before RowOverridesSchema ever sees it, so it fails loudly instead.
    if (parsed !== null && typeof parsed === "object" && Object.prototype.hasOwnProperty.call(parsed, "__proto__")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Row index "__proto__" is not a valid row index.' });
      return z.NEVER;
    }
    return parsed;
  })
  .pipe(RowOverridesSchema.optional());

// Item 2 (per-row LWIN match visibility/rejection): which matched rows the
// operator has rejected — a boolean fact about a row, so it's modeled as a
// SET of row indexes rather than a reserved key inside RowOverrideFieldsSchema
// (that schema is .strict() over exactly the 12 canonical headers by design,
// and no sentinel VALUE is safe — `producer: ""` is already meaningful).
// Mirrors RowOverridesSchema's own index format exactly: same canonical
// positive-integer regex (no leading zeros — see RowOverridesSchema's own
// comment for why), same MAX_ROWS bound. The dynamic "does this row exist in
// THIS upload" check is necessarily dynamic (same reasoning as
// RowOverridesSchema) and happens in confirmImportBatch (batch-service.ts),
// against the file's own post-merge row numbers.
export const RejectedLwinRowsSchema = z
  .array(z.string().regex(/^[1-9][0-9]*$/, "Row index must be a canonical positive whole number (no leading zeros)."))
  .superRefine((rowNumbers, ctx) => {
    if (rowNumbers.length > MAX_ROWS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Cannot reject more than ${MAX_ROWS} rows.` });
      return;
    }
    for (const key of rowNumbers) {
      const n = Number(key);
      if (!Number.isSafeInteger(n) || n < 1 || n > MAX_ROWS) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Row index ${key} is out of bounds.` });
      }
    }
  });

// Mirrors RowOverridesFieldSchema exactly: rejectedLwinRows arrives as a
// JSON-string multipart field, parsed then piped through
// RejectedLwinRowsSchema in one step. No __proto__ hardening is needed here
// (unlike RowOverridesFieldSchema) — this is a JSON ARRAY, not an object
// keyed by row index, so there is no key for "__proto__" to occupy.
export const RejectedLwinRowsFieldSchema = z
  .string()
  .max(1_000_000)
  .optional()
  .transform((val, ctx) => {
    if (val === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(val);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "rejectedLwinRows must be valid JSON." });
      return z.NEVER;
    }
    return parsed;
  })
  .pipe(RejectedLwinRowsSchema.optional());

// Sol audit round 3, finding 2 (BLOCK 2) — per matched row, the lwin_id the
// operator actually saw and accepted in preview (see ConfirmBatchOptions.
// approvedLwinRows in batch-service.ts and applyLwinApprovalVeto's own
// comment for the full veto mechanics). Same index shape/bounds as
// RowOverridesSchema (a record keyed by canonical positive-integer row
// index, no leading zeros — same reasoning as RowOverridesSchema's own
// comment), but the VALUE is a bare lwin_id string rather than a field-set
// object — never trusted as anything but a comparison target server-side,
// so only shape-checked here (non-empty, generously bounded).
export const ApprovedLwinRowsSchema = z
  .record(
    z.string().regex(/^[1-9][0-9]*$/, "Row index must be a canonical positive whole number (no leading zeros)."),
    z.string().min(1).max(200),
  )
  .superRefine((obj, ctx) => {
    const keys = Object.keys(obj);
    if (keys.length > MAX_ROWS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Cannot approve more than ${MAX_ROWS} rows.` });
      return;
    }
    for (const key of keys) {
      const n = Number(key);
      if (!Number.isSafeInteger(n) || n < 1 || n > MAX_ROWS) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Row index ${key} is out of bounds.`, path: [key] });
      }
    }
  });

// Mirrors RowOverridesFieldSchema exactly, including the __proto__
// hardening — this IS an object keyed by row index (unlike
// RejectedLwinRowsFieldSchema's plain array), so the same
// prototype-own-property gap RowOverridesFieldSchema's own comment
// describes applies here too.
export const ApprovedLwinRowsFieldSchema = z
  .string()
  .max(1_000_000)
  .optional()
  .transform((val, ctx) => {
    if (val === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(val);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "approvedLwinRows must be valid JSON." });
      return z.NEVER;
    }
    if (parsed !== null && typeof parsed === "object" && Object.prototype.hasOwnProperty.call(parsed, "__proto__")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Row index "__proto__" is not a valid row index.' });
      return z.NEVER;
    }
    return parsed;
  })
  .pipe(ApprovedLwinRowsSchema.optional());
