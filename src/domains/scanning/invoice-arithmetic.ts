/**
 * Deterministic invoice arithmetic validation (G1-12).
 *
 * Rationale: no model should establish financial truth. Claude's structured
 * extraction is a generative read of a photographed document — it can
 * transpose digits, misread a comma decimal, confuse a case price for a
 * bottle price, or mix currencies across lines. None of that is caught by
 * the model's own self-reported `confidence`, which only measures how sure
 * it is about what it read, not whether the numbers it read are internally
 * consistent.
 *
 * This module re-derives the arithmetic a wine invoice must satisfy — line
 * total = qty x unit cost, invoice total = sum of line totals + disclosed
 * tax/fees — in plain deterministic code, and flags any line or invoice
 * where the extracted numbers don't add up. It never invents a number the
 * document doesn't provide (missing line totals or an undisclosed tax line
 * just take that check out of scope, honestly, rather than guessing) and it
 * never auto-corrects a suspected error (case-vs-bottle confusion is
 * flagged, not fixed).
 *
 * Two entry points, for the two places model output flows toward
 * persistence:
 *   - `validateInvoiceArithmetic` — the full check (line + currency +
 *     invoice-level total) against a freshly extracted `ParsedInvoice`.
 *     Used by `invoice-scan-service.ts` and the re-extract route, which
 *     decide what to do with a failing result: retry once at higher
 *     effort, then route to the existing human-confirmation path.
 *   - `validateLineItemsArithmetic` — line + currency only, against a
 *     plain array of `{ qty, unitCost, lineTotal?, currency? }` items. No
 *     invoice-level total is available once items round-trip through the
 *     client (localStorage / the save request body don't carry
 *     `invoiceTotal`/`taxAndFees`), so this is what `/api/inventory/
 *     save-scan` re-validates against the *currently-being-saved* items
 *     right before they become `inventory_items` rows — never trusting a
 *     client-supplied "already validated" claim from the earlier scan
 *     response.
 */
import type {
  ArithmeticIssue,
  ArithmeticValidation,
} from "@/lib/scanner/types";
import type { ParsedInvoice } from "@/lib/scanner/schema";

/** Absolute cents-level slack for a single line — covers float/rounding noise. */
const LINE_TOLERANCE_ABS = 0.02;
/** Relative slack layered on top for larger line values. */
const LINE_TOLERANCE_REL = 0.001;
/** Floor for the invoice-level tolerance regardless of line count. */
const INVOICE_TOLERANCE_FLOOR = 0.05;

/** Common wine case-pack sizes checked for unit-cost/case-cost confusion. */
const CASE_PACK_SIZES = [6, 12] as const;

function tolerance(expected: number): number {
  return Math.max(LINE_TOLERANCE_ABS, Math.abs(expected) * LINE_TOLERANCE_REL);
}

function invoiceTolerance(expected: number, lineCount: number): number {
  return Math.max(
    INVOICE_TOLERANCE_FLOOR,
    lineCount * LINE_TOLERANCE_ABS,
    Math.abs(expected) * LINE_TOLERANCE_REL,
  );
}

// Plain "1234.56" or "1234" — no separators to disambiguate.
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;
// US/UK grouping: "1,234.56" or "1,234,567".
const THOUSANDS_COMMA_DECIMAL_DOT = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/;
// European grouping: "1.234,56" or "1.234.567".
const THOUSANDS_DOT_DECIMAL_COMMA = /^-?\d{1,3}(\.\d{3})+(,\d+)?$/;
// Bare European decimal, no grouping: "12,50".
const BARE_COMMA_DECIMAL = /^-?\d+,\d{1,2}$/;

/**
 * Normalize a monetary amount to a canonical number, explicitly handling
 * European comma-decimal formatting. Extraction fields are typed as plain
 * numbers by the schema, but this stays defensive at the validation
 * boundary — a stray raw string (an upstream loosening, a hand-built test
 * fixture, a future document source) gets parsed correctly instead of
 * silently producing wrong arithmetic.
 *
 * Returns null for values that can't be parsed unambiguously rather than
 * guessing.
 */
export function toAmount(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;

  const trimmed = value.replace(/[^0-9.,-]/g, "").trim();
  if (trimmed === "") return null;

  if (PLAIN_NUMBER.test(trimmed)) return Number(trimmed);
  if (THOUSANDS_COMMA_DECIMAL_DOT.test(trimmed)) {
    return Number(trimmed.replace(/,/g, ""));
  }
  if (THOUSANDS_DOT_DECIMAL_COMMA.test(trimmed) || BARE_COMMA_DECIMAL.test(trimmed)) {
    return Number(trimmed.replace(/\./g, "").replace(",", "."));
  }
  // "12,345" — a single comma followed by 3+ digits with no other separator
  // is ambiguous between EU decimal and US thousands grouping. Wine unit
  // costs and line totals essentially never carry 3 decimal places, so
  // treat it as US-style grouping, matching the schema's USD default.
  if (/^-?\d+,\d{3,}$/.test(trimmed)) return Number(trimmed.replace(",", ""));

  return null;
}

/**
 * Structural shape both `ParsedLineItem` (fresh model output) and the
 * client-round-tripped `LineItem` (post-edit, about to be saved) satisfy.
 * Kept minimal on purpose so either type can be validated without a cast.
 */
export type LineArithmeticInput = {
  qty: number | string;
  unitCost: number | string;
  lineTotal?: number | string | null;
  currency?: string | null;
};

export type LineArithmeticStatus =
  | "ok"
  | "not_applicable"
  | "case_bottle_confusion"
  | "mismatch";

export type LineArithmeticResult = {
  status: LineArithmeticStatus;
  issue?: ArithmeticIssue;
};

/**
 * Per-line check: qty x unit cost ~= printed line total, within
 * currency-rounding tolerance. Returns `not_applicable` when the invoice
 * doesn't print a line total for this row — we validate what the document
 * actually provides, never invent a total to check against.
 */
export function validateLineItemArithmetic(
  item: LineArithmeticInput,
  lineIndex: number,
): LineArithmeticResult {
  if (item.lineTotal == null) return { status: "not_applicable" };

  const lineTotal = toAmount(item.lineTotal);
  const qty = toAmount(item.qty);
  const unitCost = toAmount(item.unitCost);

  if (lineTotal == null || qty == null || unitCost == null) {
    return {
      status: "mismatch",
      issue: {
        type: "line_mismatch",
        lineIndex,
        message: `Line ${lineIndex + 1}: could not parse qty, unit cost, or line total as numbers.`,
      },
    };
  }

  const expected = qty * unitCost;
  if (Math.abs(expected - lineTotal) <= tolerance(expected)) {
    return { status: "ok" };
  }

  for (const caseSize of CASE_PACK_SIZES) {
    const scaled = expected * caseSize;
    if (Math.abs(scaled - lineTotal) <= tolerance(scaled)) {
      return {
        status: "case_bottle_confusion",
        issue: {
          type: "case_bottle_confusion",
          lineIndex,
          expected,
          actual: lineTotal,
          multiplier: caseSize,
          message:
            `Line ${lineIndex + 1}: qty (${qty}) x unit cost (${unitCost}) x ${caseSize} ` +
            `matches the printed line total (${lineTotal}) — unit cost may be a per-case ` +
            `price applied as a per-bottle price, or vice versa. Flagged for human review, ` +
            `not auto-corrected.`,
        },
      };
    }
  }

  return {
    status: "mismatch",
    issue: {
      type: "line_mismatch",
      lineIndex,
      expected,
      actual: lineTotal,
      message:
        `Line ${lineIndex + 1}: qty (${qty}) x unit cost (${unitCost}) = ${expected.toFixed(2)}, ` +
        `but the printed line total is ${lineTotal.toFixed(2)}.`,
    },
  };
}

/**
 * All extracted line items must agree on currency before their totals can
 * be safely summed against the invoice total — adding USD and EUR amounts
 * as if equal would be exactly the kind of silent, model-established
 * "truth" this validation exists to prevent.
 */
function validateCurrencyConsistency(
  items: Pick<LineArithmeticInput, "currency">[],
): ArithmeticIssue[] {
  const currencies = new Set(
    items.map((item) => item.currency).filter((c): c is string => Boolean(c)),
  );
  if (currencies.size <= 1) return [];
  return [
    {
      type: "currency_mismatch",
      message: `Line items report inconsistent currencies (${[...currencies].sort().join(", ")}); cannot safely sum line totals without a conversion this system will not perform silently.`,
    },
  ];
}

/**
 * Line-level + currency checks only — no invoice-level total check, since
 * that requires `invoiceTotal`/`taxAndFees` which aren't available once
 * items round-trip through the client. See `/api/inventory/save-scan`,
 * which uses this to re-validate the items actually about to be persisted.
 */
export function validateLineItemsArithmetic(
  items: LineArithmeticInput[],
): ArithmeticValidation {
  const issues: ArithmeticIssue[] = [];

  items.forEach((item, lineIndex) => {
    const result = validateLineItemArithmetic(item, lineIndex);
    if (result.issue) issues.push(result.issue);
  });

  issues.push(...validateCurrencyConsistency(items));

  return { ok: issues.length === 0, issues };
}

/**
 * Invoice-level check: sum of line totals + disclosed tax/fees ~= printed
 * invoice total. Skips honestly (returns no issues) whenever the document
 * doesn't provide enough to check: no printed invoice total, or any line
 * missing its own line total (a partial sum can't be compared to the full
 * total without inventing the missing figures).
 */
function validateInvoiceTotal(parsed: ParsedInvoice): ArithmeticIssue[] {
  if (parsed.invoiceTotal == null) return [];
  if (parsed.lineItems.length === 0) return [];
  if (parsed.lineItems.some((item) => item.lineTotal == null)) return [];

  const invoiceTotal = toAmount(parsed.invoiceTotal);
  if (invoiceTotal == null) return [];

  let sum = 0;
  for (const item of parsed.lineItems) {
    const lineTotal = toAmount(item.lineTotal);
    if (lineTotal == null) return []; // unparseable — the per-line check already flags this row
    sum += lineTotal;
  }

  const taxAndFees = parsed.taxAndFees == null ? 0 : (toAmount(parsed.taxAndFees) ?? 0);
  const expected = sum + taxAndFees;
  const tol = invoiceTolerance(expected, parsed.lineItems.length);
  if (Math.abs(expected - invoiceTotal) <= tol) return [];

  return [
    {
      type: "invoice_total_mismatch",
      expected,
      actual: invoiceTotal,
      message:
        `Line totals${parsed.taxAndFees != null ? " plus disclosed tax/fees" : ""} sum to ` +
        `${expected.toFixed(2)}, but the printed invoice total is ${invoiceTotal.toFixed(2)}.`,
    },
  ];
}

/**
 * Runs every deterministic arithmetic check against a freshly extracted
 * invoice. `ok: false` means at least one line or invoice-level check
 * failed to reconcile — the caller must not treat this extraction as
 * trustworthy without a human looking at it.
 */
export function validateInvoiceArithmetic(parsed: ParsedInvoice): ArithmeticValidation {
  const { issues } = validateLineItemsArithmetic(parsed.lineItems);
  issues.push(...validateInvoiceTotal(parsed));

  return { ok: issues.length === 0, issues };
}
