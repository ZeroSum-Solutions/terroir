"use client";

// The preview's "Row errors" section and the inline row-fix form inside it.
// Extracted verbatim from import-client.tsx — PreviewStep still owns the
// disclosure count and every override, and passes them straight through.

import type { Dispatch, SetStateAction } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { CANONICAL_HEADERS, MAX_FIELD_LENGTH, type CanonicalHeader } from "@/domains/import/constants";
import { validateFields } from "@/domains/import/row-validator";
import type { ErrorRowEntry, RowOverrides } from "@/domains/import/review-types";

// Round-1 fix: only the first N error rows were ever shown/editable, with
// any beyond this hard cap silently excluded from an inline fix — no
// second chance, and the overflow warning never went away. Sol round-2
// audit (2026-08-27) finding 4: PreviewStep now uses this as the initial
// PAGE size instead of a hard cap — "Show N more" reveals the next
// MAX_SHOWN_ERROR_ROWS rows, repeatable until every error row is shown,
// and the overflow warning disappears once nothing is left hidden.
export const MAX_SHOWN_ERROR_ROWS = 100;

const FIELD_LABELS: Record<CanonicalHeader, string> = {
  producer: "Producer",
  name: "Name",
  vintage: "Vintage",
  varietal: "Varietal",
  region: "Region",
  country: "Country",
  size_ml: "Size (ml)",
  format: "Format",
  currency: "Currency",
  quantity: "Quantity",
  unit_cost: "Unit cost",
  bin: "Bin",
  section: "Section",
};

export function PreviewErrorRows({
  shownErrorRows,
  hiddenCount,
  rowOverrides,
  onRowFieldChange,
  isRowLocked,
  isRowSkipped,
  confirming,
  setShownCount,
}: {
  shownErrorRows: ErrorRowEntry[];
  hiddenCount: number;
  rowOverrides: RowOverrides;
  onRowFieldChange: (rowNumber: number, field: CanonicalHeader, value: string) => void;
  isRowLocked: (rowNumber: number) => boolean;
  isRowSkipped?: (rowNumber: number) => boolean;
  confirming: boolean;
  setShownCount: Dispatch<SetStateAction<number>>;
}) {
  if (shownErrorRows.length === 0) return null;
  return (
    <div className="mt-lg">
      <h3 className="text-caption font-medium uppercase tracking-[0.18em] text-grey">
        Row errors
      </h3>
      <p className="mt-2xs text-caption text-grey">
        Edit a field below to fix a row inline — it counts toward the import once it&rsquo;s valid.
      </p>
      {confirming && (
        // Sol round-3 audit (2026-08-27) finding 1: a confirm attempt
        // snapshots rowOverrides the instant it starts — any edit made
        // while it's in flight can never actually be sent for chunks
        // this attempt already dispatched (or is about to), so every
        // input freezes for the duration rather than accepting an edit
        // that would silently go nowhere. isRowLocked (below) governs
        // the PERMANENT lock once a chunk is actually confirmed; this
        // is the separate, temporary freeze for the attempt itself.
        <p role="status" className="mt-2xs flex items-center gap-xs text-caption text-accent">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          Import in progress — row edits are locked during upload.
        </p>
      )}
      <ul className="mt-xs space-y-2xs">
        {shownErrorRows.map((row) => (
          <RowFixItem
            key={row.rowNumber}
            row={row}
            override={rowOverrides[row.rowNumber]}
            onFieldChange={onRowFieldChange}
            locked={isRowLocked(row.rowNumber)}
            skipped={isRowSkipped?.(row.rowNumber) ?? false}
            frozen={confirming}
          />
        ))}
      </ul>
      {hiddenCount > 0 && (
        <>
          <p role="alert" className="mt-2xs flex items-start gap-xs text-caption text-risk-ink">
            <AlertTriangle className="mt-[2px] h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {hiddenCount} more row(s) with errors are not shown yet.
          </p>
          <button
            type="button"
            onClick={() => setShownCount((count) => count + MAX_SHOWN_ERROR_ROWS)}
            className="mt-xs min-h-11 rounded-pill border border-edge bg-surface px-md text-[13px] font-medium text-ink transition-colors hover:bg-wash focus-ring"
          >
            Show {Math.min(hiddenCount, MAX_SHOWN_ERROR_ROWS)} more row(s) with errors
          </button>
        </>
      )}
    </div>
  );
}

/** One error row's inline fix form: an input per field the row actually
 * failed on, prefilled with the exact text that failed (rawText), live
 * re-validated through the SAME row-validator.ts logic the server uses —
 * so "this row will now import" is never a guess.
 *
 * Sol round-2 audit (2026-08-27) finding 1: once `locked` (this row's
 * chunk is already confirmed), further edits could never actually be
 * resent — confirmChunkedSession's retry loop skips a confirmed chunk
 * entirely — so the inputs render read-only/disabled instead of silently
 * accepting edits that would go nowhere.
 *
 * Sol round-3 audit (2026-08-27) finding 1: `frozen` is the separate,
 * TEMPORARY freeze for a confirm attempt currently in flight — the
 * attempt snapshots rowOverrides the instant it starts, so an edit made
 * while it's running could never actually be sent, for the same reason
 * `locked` disables a row (it would silently go nowhere). Unlike `locked`,
 * `frozen` clears once the attempt settles — a row in a failed or
 * never-attempted chunk becomes editable again.
 *
 * finding 5: the LABEL is "Chunk N, data row M" when row carries
 * chunkIndex/chunkRowNumber (the chunked path) — an honest, chunk-scoped
 * claim — never "Row {row.rowNumber}" for that path, since rowNumber
 * there is a startRow-adjusted number that can look like, but is not, a
 * true physical spreadsheet row (see ErrorRowEntry's own comment). The
 * plain (non-chunked) path has no chunk concept, so it keeps "Row N". */
function RowFixItem({
  row,
  override,
  onFieldChange,
  locked,
  skipped,
  frozen,
}: {
  row: ErrorRowEntry;
  override: Partial<Record<CanonicalHeader, string>> | undefined;
  onFieldChange: (rowNumber: number, field: CanonicalHeader, value: string) => void;
  locked: boolean;
  /** Round-6 audit finding 5: true for a row belonging to a client-side
   * skipped chunk — its edits are exactly as impossible to ever resend as
   * a `locked` row's, but the reason (and the way back — "Undo skip") is
   * different, so it renders a distinct message. */
  skipped: boolean;
  frozen: boolean;
}) {
  const disabled = locked || skipped || frozen;
  const effective: Record<CanonicalHeader, string> = { ...row.rawText, ...override };
  const live = validateFields(effective);
  const editableFields = Array.from(new Set(row.errors.map((e) => e.field))).filter(
    (field): field is CanonicalHeader => (CANONICAL_HEADERS as readonly string[]).includes(field),
  );
  const label =
    row.chunkIndex !== undefined && row.chunkRowNumber !== undefined
      ? `Chunk ${row.chunkIndex}, data row ${row.chunkRowNumber}`
      : `Row ${row.rowNumber}`;

  return (
    <li className="rounded-md bg-wash px-sm py-xs text-[13px] text-ink">
      <div className="flex items-center gap-xs">
        <span>{label}</span>
        {!disabled && live.state === "valid" && (
          <span className="inline-flex items-center gap-2xs text-primary">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
            Fixed
          </span>
        )}
      </div>
      <p className="mt-2xs text-caption text-grey">
        {locked
          ? "Row already imported with this chunk — revert the import to change it."
          : skipped
            ? "Row belongs to a skipped chunk."
            : frozen
              ? "Import in progress — this row is locked until the upload finishes."
              : live.state === "error"
                ? live.errors.map((e) => e.message).join(" ")
                : "This row will be imported once you confirm."}
      </p>
      <div className="mt-xs flex flex-wrap gap-sm">
        {editableFields.map((field) => (
          <label key={field} className="flex flex-col gap-2xs text-caption text-grey">
            {FIELD_LABELS[field]}
            <input
              type="text"
              value={effective[field] ?? ""}
              onChange={(e) => onFieldChange(row.rowNumber, field, e.target.value)}
              maxLength={MAX_FIELD_LENGTH}
              disabled={disabled}
              readOnly={disabled}
              className={cn(
                "min-h-11 w-32 rounded-pill border border-rule bg-surface px-sm text-[13px] text-ink focus:border-accent focus-ring",
                disabled && "cursor-not-allowed opacity-60",
              )}
            />
          </label>
        ))}
      </div>
    </li>
  );
}
