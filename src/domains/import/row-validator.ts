// G1-4 — per-row schema validation for CSV cellar import.

import {
  ALLOWED_CURRENCIES,
  CANONICAL_HEADERS,
  FLOAT_LITERAL,
  HEADER_SYNONYMS,
  INTEGER_LITERAL,
  MAX_QUANTITY,
  MAX_UNIT_COST,
  REQUIRED_HEADERS,
  type CanonicalHeader,
} from "./constants";

export type FieldError = { field: string; message: string };

/** Canonical field values as strings (or null), ready to persist into
 * import_batch_rows.raw jsonb — the same shape apply_import_batch_chunk
 * reads back out with `->> 'field'`. */
export type RawRowFields = Record<CanonicalHeader, string | null>;

export type ValidRow = {
  state: "valid";
  raw: RawRowFields;
  costMissing: boolean;
  producer: string;
  name: string;
};

export type InvalidRow = {
  state: "error";
  raw: RawRowFields;
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

const CURRENT_YEAR = new Date().getFullYear();
const MIN_VINTAGE = 1900;

function cell(cells: string[], columnToField: Map<number, CanonicalHeader>, field: CanonicalHeader): string {
  for (const [index, mapped] of columnToField) {
    if (mapped === field) return (cells[index] ?? "").trim();
  }
  return "";
}

/**
 * Validate one CSV data row against the canonical schema. Never throws —
 * every outcome is either a valid row (with an explicit costMissing
 * flag, never a silently-defaulted 0) or an error row with row-number-
 * free, field-attributed reasons (the caller attaches the row number).
 */
export function validateRow(
  cells: string[],
  columnToField: Map<number, CanonicalHeader>,
): ValidatedRow {
  const get = (field: CanonicalHeader) => cell(cells, columnToField, field);
  const errors: FieldError[] = [];

  const producer = get("producer");
  if (!producer) errors.push({ field: "producer", message: "Producer is required." });

  const name = get("name");
  if (!name) errors.push({ field: "name", message: "Wine name is required." });

  // C18 (db audit 2026-08-23): Number.parseInt/parseFloat accept a numeric
  // PREFIX and silently ignore trailing garbage ('2015abc' -> 2015,
  // '750ml' -> 750, '12.5.7' -> 12.50). Every numeric field below is
  // tested against a whole-string literal regex FIRST — any non-match is
  // a field error, before the numeric parse ever runs.
  let vintage: number | null = null;
  const vintageRaw = get("vintage");
  if (vintageRaw) {
    if (!INTEGER_LITERAL.test(vintageRaw)) {
      errors.push({ field: "vintage", message: "Vintage must be a whole number, with no other characters." });
    } else {
      const parsed = Number.parseInt(vintageRaw, 10);
      if (parsed < MIN_VINTAGE || parsed > CURRENT_YEAR + 1) {
        errors.push({ field: "vintage", message: `Vintage must be a year between ${MIN_VINTAGE} and ${CURRENT_YEAR + 1}.` });
      } else {
        vintage = parsed;
      }
    }
  }

  let sizeMl: number | null = 750;
  const sizeRaw = get("size_ml");
  if (sizeRaw) {
    if (!INTEGER_LITERAL.test(sizeRaw)) {
      errors.push({ field: "size_ml", message: "Bottle size (ml) must be a whole number, with no other characters." });
    } else {
      const parsed = Number.parseInt(sizeRaw, 10);
      if (parsed <= 0) {
        errors.push({ field: "size_ml", message: "Bottle size (ml) must be a positive whole number." });
      } else {
        sizeMl = parsed;
      }
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
  const costRaw = get("unit_cost");
  if (!costRaw) {
    costMissing = true;
  } else if (!FLOAT_LITERAL.test(costRaw)) {
    errors.push({ field: "unit_cost", message: "Unit cost must be a number, with no other characters." });
  } else {
    const parsed = Number.parseFloat(costRaw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      errors.push({ field: "unit_cost", message: "Unit cost must be a non-negative number." });
    } else if (parsed > MAX_UNIT_COST) {
      errors.push({ field: "unit_cost", message: `Unit cost cannot exceed ${MAX_UNIT_COST}.` });
    } else {
      unitCost = Math.round(parsed * 100) / 100;
    }
  }

  const currencyRaw = get("currency");
  if (currencyRaw && !ALLOWED_CURRENCIES.has(currencyRaw.toUpperCase())) {
    errors.push({ field: "currency", message: `Currency must be one of: ${[...ALLOWED_CURRENCIES].join(", ")}.` });
  }

  const raw: RawRowFields = Object.fromEntries(
    CANONICAL_HEADERS.map((field) => [field, null]),
  ) as RawRowFields;
  raw.producer = producer || null;
  raw.name = name || null;
  raw.vintage = vintage !== null ? String(vintage) : null;
  raw.varietal = get("varietal") || null;
  raw.region = get("region") || null;
  raw.country = get("country") || null;
  raw.size_ml = sizeMl !== null ? String(sizeMl) : null;
  raw.format = get("format") || null;
  raw.currency = currencyRaw ? currencyRaw.toUpperCase() : null;
  raw.quantity = quantity !== null ? String(quantity) : null;
  raw.unit_cost = unitCost !== null ? unitCost.toFixed(2) : null;
  raw.bin = get("bin") || null;
  raw.section = get("section") || null;

  if (errors.length > 0) {
    return { state: "error", raw, errors };
  }

  return { state: "valid", raw, costMissing, producer, name };
}
