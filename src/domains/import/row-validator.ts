// G1-4 — per-row schema validation for CSV cellar import.

import {
  ALLOWED_CURRENCIES,
  CANONICAL_HEADERS,
  CURRENCY_SYMBOL_TO_CODE,
  FLOAT_LITERAL,
  HEADER_SYNONYMS,
  INTEGER_LITERAL,
  MAX_BOTTLE_SIZE_ML,
  MAX_QUANTITY,
  MAX_UNIT_COST,
  REQUIRED_HEADERS,
  type CanonicalHeader,
} from "./constants";
import { normalizeVintage, MIN_VINTAGE, CURRENT_YEAR } from "../identity/normalize";

export type FieldError = { field: string; message: string };

/** Canonical field values as strings (or null), ready to persist into
 * import_batch_rows.raw jsonb — the same shape apply_import_batch_chunk
 * reads back out with `->> 'field'`. */
export type RawRowFields = Record<CanonicalHeader, string | null>;

/** Already-extracted field text, keyed by canonical field — the shape
 * validateFields consumes directly. Whatever sourced it (a CSV cell, an
 * inline-edit override, a UI form draft) is irrelevant past this point;
 * every field is optional (an absent key means "no text for this field",
 * same as an empty cell). */
export type FieldsInput = Partial<Record<CanonicalHeader, string>>;

export type ValidRow = {
  state: "valid";
  raw: RawRowFields;
  /** The exact (trimmed) input text validateFields was given for every
   * canonical field, valid or not — round-trips into an inline-edit form
   * so a UI can prefill it, unlike `raw`, which normalizes/nulls a field
   * the moment it fails its own validation. */
  rawText: Record<CanonicalHeader, string>;
  costMissing: boolean;
  producer: string;
  name: string;
};

export type InvalidRow = {
  state: "error";
  raw: RawRowFields;
  rawText: Record<CanonicalHeader, string>;
  errors: FieldError[];
};

export type ValidatedRow = ValidRow | InvalidRow;

/**
 * Map a CSV header row to canonical field names. Unknown columns are
 * ignored (not an error — an operator's export may carry extra columns
 * this importer doesn't use). Returns which required canonical headers,
 * if any, are missing.
 */
export function mapHeader(header: string[]): {
  columnToField: Map<number, CanonicalHeader>;
  missingRequired: CanonicalHeader[];
} {
  const columnToField = new Map<number, CanonicalHeader>();
  const seen = new Set<CanonicalHeader>();
  header.forEach((rawName, index) => {
    const key = rawName.trim().toLowerCase();
    const field = HEADER_SYNONYMS[key];
    if (field && !seen.has(field)) {
      columnToField.set(index, field);
      seen.add(field);
    }
  });
  const missingRequired = REQUIRED_HEADERS.filter((f) => !seen.has(f));
  return { columnToField, missingRequired };
}

function cell(cells: string[], columnToField: Map<number, CanonicalHeader>, field: CanonicalHeader): string {
  for (const [index, mapped] of columnToField) {
    if (mapped === field) return (cells[index] ?? "").trim();
  }
  return "";
}

/** Unambiguous thousands-separated numbers (Sol audit 2026-08-27,
 * finding 2). Because decimal commas are also supported, a LONE
 * three-digit comma group with no dot ("1,234") could mean 1234 OR
 * 1.234 — a ~1000x cost difference — so it is rejected outright, never
 * guessed. Thousands are only accepted when nothing else could be
 * meant: two-plus comma groups (a decimal comma is always single), or
 * one group WITH a decimal dot (a decimal comma never coexists with a
 * dot). */
const THOUSANDS_MULTI_GROUP = /^\d{1,3}(?:,\d{3}){2,}(?:\.\d+)?$/;
const THOUSANDS_WITH_DOT = /^\d{1,3}(?:,\d{3})+\.\d+$/;

/** European decimal comma ("45,50") — one comma, at most TWO digits
 * after it, no dot. Three digits after a lone comma falls through to
 * the ambiguity rejection above. */
const DECIMAL_COMMA_LITERAL = /^\d+,\d{1,2}$/;

/**
 * Normalize a real-world money cell ("$2,034.00", "€45,50", "£1,200.50")
 * to a plain decimal string, plus the currency inferred from an
 * unambiguous symbol. Returns null when the cell can't be read as one
 * non-negative money amount — the caller reports that as a field error,
 * never as a missing cost (the cell wasn't blank). Whatever survives
 * still has to pass the strict FLOAT_LITERAL gate (C18) downstream.
 */
export function normalizeMoneyText(rawText: string): { text: string; symbolCurrency: string | null } | null {
  let text = rawText.trim();
  let symbolCurrency: string | null = null;

  const leading = text.match(/^([$€£¥])\s?/);
  const trailing = leading ? null : text.match(/\s?([$€£¥])$/);
  const symbol = leading?.[1] ?? trailing?.[1] ?? null;
  if (symbol) {
    text = leading ? text.slice(leading[0].length) : text.slice(0, text.length - (trailing as RegExpMatchArray)[0].length);
    symbolCurrency = CURRENCY_SYMBOL_TO_CODE[symbol] ?? null;
  }

  if (text.includes(",")) {
    if (THOUSANDS_MULTI_GROUP.test(text) || THOUSANDS_WITH_DOT.test(text)) {
      text = text.replaceAll(",", "");
    } else if (DECIMAL_COMMA_LITERAL.test(text)) {
      text = text.replace(",", ".");
    } else {
      return null;
    }
  }

  if (text.length === 0) return null;
  return { text, symbolCurrency };
}

const VOLUME_LITERAL = /^(\d+)(?:\.(\d+))?\s*(ml|cl|l)$/i;
const VOLUME_UNIT_DECIMAL_SHIFT: Record<string, number> = { ml: 0, cl: 1, l: 3 };

/** Digit-string bound check shared by both size forms (Sol audit
 * 2026-08-27, finding 3): parseInt silently loses precision past
 * MAX_SAFE_INTEGER and very long digit strings reach Infinity, so the
 * bound is applied to the DIGITS, before any Number conversion. */
function boundedWholeMl(digits: string): number | null {
  const trimmed = digits.replace(/^0+(?=\d)/, "");
  if (trimmed.length > String(MAX_BOTTLE_SIZE_ML).length) return null;
  const value = Number(trimmed);
  return value > 0 && value <= MAX_BOTTLE_SIZE_ML ? value : null;
}

/**
 * Parse a real-world bottle-size cell into whole ml: bare ml integers
 * ("750") plus unit-suffixed volumes ("750ml", "75cl", "1.5L"). The unit
 * conversion is exact decimal-shift string arithmetic, never binary
 * float multiplication (which computes 1.001 * 1000 as 1000.999…9 and
 * would wrongly reject an exactly-whole 1001 ml). Null for anything
 * else, including a conversion that doesn't land on a whole ml count in
 * (0, MAX_BOTTLE_SIZE_ML] — rounding a volume would silently alter
 * cellar data.
 */
export function parseBottleSizeMl(rawText: string): number | null {
  if (/^\d+$/.test(rawText)) return boundedWholeMl(rawText);
  const match = rawText.match(VOLUME_LITERAL);
  if (!match) return null;
  const shift = VOLUME_UNIT_DECIMAL_SHIFT[match[3].toLowerCase()];
  const frac = match[2] ?? "";
  // Shift the decimal point right by `shift` digits, exactly: digits that
  // remain to the right after the shift must all be zero.
  const shifted = match[1] + frac.slice(0, shift).padEnd(shift, "0");
  if (/[^0]/.test(frac.slice(shift))) return null;
  return boundedWholeMl(shifted);
}

/**
 * Validate one row's already-extracted field text against the canonical
 * schema. This is the SHARED core both validateRow (CSV path) and inline
 * row-fix editing (UI path — see import-client.tsx/session-step.tsx) call
 * through, so a browser re-validating an operator's edit can never
 * disagree with what the server will do with the same text. Never
 * throws — every outcome is either a valid row (with an explicit
 * costMissing flag, never a silently-defaulted 0) or an error row with
 * row-number-free, field-attributed reasons (the caller attaches the row
 * number).
 */
export function validateFields(fields: FieldsInput): ValidatedRow {
  const rawText = Object.fromEntries(
    CANONICAL_HEADERS.map((field) => [field, (fields[field] ?? "").trim()]),
  ) as Record<CanonicalHeader, string>;
  const get = (field: CanonicalHeader) => rawText[field];
  const errors: FieldError[] = [];

  // Producer is optional (2026-08-27): real-world exports embed it in the
  // wine name. It stays a string ("" when absent) all the way into
  // raw.producer — never null, because apply (0108) inserts raw->>
  // 'producer' straight into wines.producer, which is NOT NULL (0002).
  const producer = get("producer");

  const name = get("name");
  if (!name) errors.push({ field: "name", message: "Wine name is required." });

  // P2 NV fix (docs/plans/2026-08-23-p2-identity-spine.md §5): literal
  // "NV" and its closed-allowlist siblings ("N V", "non vintage", "MV",
  // etc. — see normalizeVintage) are the identity fact "no vintage," not
  // malformed data. normalizeVintage throws for anything else that isn't
  // a valid year in range — and (C18, db audit 2026-08-23, folded into
  // normalizeVintage at integration) it whole-string-matches the digits
  // first, so a numeric prefix with trailing garbage ("2015abc") is a
  // field error, never a silent truncation. The other numeric fields
  // below keep C18's INTEGER_LITERAL / decimal-literal guards verbatim.
  let vintage: number | null = null;
  const vintageRaw = get("vintage");
  if (vintageRaw) {
    try {
      vintage = normalizeVintage(vintageRaw);
    } catch {
      errors.push({ field: "vintage", message: `Vintage must be a year between ${MIN_VINTAGE} and ${CURRENT_YEAR + 1}.` });
    }
  }

  let sizeMl: number | null = 750;
  const sizeRaw = get("size_ml");
  if (sizeRaw) {
    const parsed = parseBottleSizeMl(sizeRaw);
    if (parsed === null) {
      errors.push({ field: "size_ml", message: "Bottle size must be whole ml (e.g. 750) or a volume like 750ml, 75cl, or 1.5L." });
    } else {
      sizeMl = parsed;
    }
  }

  let quantity: number | null = null;
  const quantityRaw = get("quantity");
  if (!quantityRaw) {
    errors.push({ field: "quantity", message: "Quantity is required." });
  } else if (!INTEGER_LITERAL.test(quantityRaw)) {
    errors.push({ field: "quantity", message: "Quantity must be a whole number, with no other characters." });
  } else {
    const parsed = Number.parseInt(quantityRaw, 10);
    if (parsed < 0) {
      errors.push({ field: "quantity", message: "Quantity must be a non-negative whole number." });
    } else if (parsed > MAX_QUANTITY) {
      errors.push({ field: "quantity", message: `Quantity cannot exceed ${MAX_QUANTITY}.` });
    } else {
      quantity = parsed;
    }
  }

  // Cost is a three-way outcome, never a silent default:
  //   blank/absent -> missing (the operator must decide, see bar 5)
  //   present but not a valid non-negative number -> a validation error
  //   present and valid -> the value itself
  let unitCost: number | null = null;
  let costMissing = false;
  let symbolCurrency: string | null = null;
  const costRaw = get("unit_cost");
  const normalizedCost = costRaw ? normalizeMoneyText(costRaw) : null;
  if (!costRaw) {
    costMissing = true;
  } else if (normalizedCost === null || !FLOAT_LITERAL.test(normalizedCost.text)) {
    errors.push({ field: "unit_cost", message: "Unit cost must be a number (a currency symbol and thousands separators are OK)." });
  } else {
    symbolCurrency = normalizedCost.symbolCurrency;
    const parsed = Number.parseFloat(normalizedCost.text);
    if (!Number.isFinite(parsed) || parsed < 0) {
      errors.push({ field: "unit_cost", message: "Unit cost must be a non-negative number." });
    } else if (parsed > MAX_UNIT_COST) {
      errors.push({ field: "unit_cost", message: `Unit cost cannot exceed ${MAX_UNIT_COST}.` });
    } else {
      unitCost = Math.round(parsed * 100) / 100;
    }
  }

  // An explicit currency column always wins; a symbol on the cost cell
  // only fills the gap when that column is absent or blank.
  const currencyRaw = get("currency");
  if (currencyRaw && !ALLOWED_CURRENCIES.has(currencyRaw.toUpperCase())) {
    errors.push({ field: "currency", message: `Currency must be one of: ${[...ALLOWED_CURRENCIES].join(", ")}.` });
  }

  const raw: RawRowFields = Object.fromEntries(
    CANONICAL_HEADERS.map((field) => [field, null]),
  ) as RawRowFields;
  raw.producer = producer;
  raw.name = name || null;
  raw.vintage = vintage !== null ? String(vintage) : null;
  raw.varietal = get("varietal") || null;
  raw.region = get("region") || null;
  raw.country = get("country") || null;
  raw.size_ml = sizeMl !== null ? String(sizeMl) : null;
  raw.format = get("format") || null;
  raw.currency = currencyRaw ? currencyRaw.toUpperCase() : symbolCurrency;
  raw.quantity = quantity !== null ? String(quantity) : null;
  raw.unit_cost = unitCost !== null ? unitCost.toFixed(2) : null;
  raw.bin = get("bin") || null;
  raw.section = get("section") || null;

  if (errors.length > 0) {
    return { state: "error", raw, rawText, errors };
  }

  return { state: "valid", raw, rawText, costMissing, producer, name };
}

/**
 * Validate one CSV data row against the canonical schema: extracts every
 * canonical field's cell text (via columnToField), applies `overrides` on
 * top field-by-field (an inline row fix — see ConfirmBatchOptions.
 * rowOverrides in batch-service.ts), then hands the result to
 * validateFields. Overrides are applied here, BEFORE validateFields ever
 * runs, so server-side validation stays the sole authority: a
 * still-invalid override rejects the row with the normal per-row reason,
 * never a bypass.
 */
export function validateRow(
  cells: string[],
  columnToField: Map<number, CanonicalHeader>,
  overrides?: FieldsInput,
): ValidatedRow {
  const fields: FieldsInput = {};
  for (const field of CANONICAL_HEADERS) {
    fields[field] = cell(cells, columnToField, field);
  }
  if (overrides) {
    for (const field of CANONICAL_HEADERS) {
      const value = overrides[field];
      if (value !== undefined) fields[field] = value;
    }
  }
  return validateFields(fields);
}
