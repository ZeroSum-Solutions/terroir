import { describe, expect, it } from "vitest";
import { mapHeader, validateRow } from "./row-validator";
import { MAX_QUANTITY, MAX_UNIT_COST } from "./constants";

const HEADER = ["Producer", "Wine", "Vintage", "Qty", "Unit Cost"];
const FULL_HEADER = [
  "Producer",
  "Wine",
  "Vintage",
  "Varietal",
  "Region",
  "Country",
  "Size (ml)",
  "Format",
  "Currency",
  "Qty",
  "Unit Cost",
  "Bin",
  "Section",
];

function map() {
  return mapHeader(HEADER);
}
function fullMap() {
  return mapHeader(FULL_HEADER);
}

describe("mapHeader", () => {
  it("maps canonical + synonym headers case-insensitively", () => {
    const { columnToField, missingRequired } = map();
    expect(columnToField.get(0)).toBe("producer");
    expect(columnToField.get(1)).toBe("name");
    expect(columnToField.get(2)).toBe("vintage");
    expect(columnToField.get(3)).toBe("quantity");
    expect(columnToField.get(4)).toBe("unit_cost");
    expect(missingRequired).toEqual([]);
  });

  it("reports missing required headers", () => {
    const { missingRequired } = mapHeader(["Region", "Country"]);
    expect(missingRequired).toEqual(["producer", "name", "quantity"]);
  });
});

describe("validateRow", () => {
  const { columnToField } = map();

  it("accepts a fully valid row", () => {
    const result = validateRow(["Domaine A", "Cuvee 1", "2020", "6", "24.50"], columnToField);
    expect(result.state).toBe("valid");
    if (result.state !== "valid") return;
    expect(result.costMissing).toBe(false);
    expect(result.raw.producer).toBe("Domaine A");
    expect(result.raw.vintage).toBe("2020");
    expect(result.raw.quantity).toBe("6");
    expect(result.raw.unit_cost).toBe("24.50");
  });

  it("requires producer, name, and quantity", () => {
    const result = validateRow(["", "", "2020", "", "24.50"], columnToField);
    expect(result.state).toBe("error");
    if (result.state !== "error") return;
    const fields = result.errors.map((e) => e.field);
    expect(fields).toEqual(expect.arrayContaining(["producer", "name", "quantity"]));
  });

  it("treats a blank unit cost as missing, not a zero default", () => {
    const result = validateRow(["Domaine A", "Cuvee 1", "2020", "6", ""], columnToField);
    expect(result.state).toBe("valid");
    if (result.state !== "valid") return;
    expect(result.costMissing).toBe(true);
    expect(result.raw.unit_cost).toBeNull();
  });

  it("rejects a garbage (non-numeric) unit cost as a validation error, not a missing-cost row", () => {
    const result = validateRow(["Domaine A", "Cuvee 1", "2020", "6", "N/A"], columnToField);
    expect(result.state).toBe("error");
    if (result.state !== "error") return;
    expect(result.errors.some((e) => e.field === "unit_cost")).toBe(true);
  });

  it("rejects a negative unit cost", () => {
    const result = validateRow(["Domaine A", "Cuvee 1", "2020", "6", "-5"], columnToField);
    expect(result.state).toBe("error");
  });

  it("rejects an out-of-range vintage", () => {
    const result = validateRow(["Domaine A", "Cuvee 1", "1899", "6", "10"], columnToField);
    expect(result.state).toBe("error");
    if (result.state !== "error") return;
    expect(result.errors.some((e) => e.field === "vintage")).toBe(true);
  });

  it("rejects a negative quantity", () => {
    const result = validateRow(["Domaine A", "Cuvee 1", "2020", "-1", "10"], columnToField);
    expect(result.state).toBe("error");
  });

  it("defaults size_ml to 750 when absent", () => {
    const result = validateRow(["Domaine A", "Cuvee 1", "2020", "6", "10"], columnToField);
    expect(result.state).toBe("valid");
    if (result.state !== "valid") return;
    expect(result.raw.size_ml).toBe("750");
  });

  it("rounds unit cost to 2 decimal places", () => {
    const result = validateRow(["Domaine A", "Cuvee 1", "2020", "6", "10.999"], columnToField);
    expect(result.state).toBe("valid");
    if (result.state !== "valid") return;
    expect(result.raw.unit_cost).toBe("11.00");
  });
});

// P3 (db audit 2026-08-23, C18) — Number.parseInt/parseFloat accept a
// numeric PREFIX and silently ignore trailing garbage. Every case below
// FAILS (returns a "2020" style coerced value as `valid`, not an error)
// against the pre-fix validator — comment out the INTEGER_LITERAL/
// FLOAT_LITERAL .test(...) guards in row-validator.ts (i.e. go back to
// calling Number.parseInt/parseFloat directly on the raw string with no
// literal check first) and every one of these turns red. That one-line-
// per-field change is the exact regression this suite pins against.
describe("C18: silent numeric-text coercion is rejected outright", () => {
  const { columnToField } = fullMap();
  function row(fields: Partial<Record<string, string>>): string[] {
    const order = [
      "producer", "name", "vintage", "varietal", "region", "country",
      "size_ml", "format", "currency", "quantity", "unit_cost", "bin", "section",
    ];
    return order.map((f) => fields[f] ?? "");
  }

  it.each([
    ["vintage", "2015abc", "vintage"],
    ["size_ml", "750ml", "size_ml"],
    ["unit_cost", "12.5.7", "unit_cost"],
    ["quantity", "3abc", "quantity"],
  ])("%s with trailing-garbage text %j is a field error, not a silently-coerced value", (field, raw, expectedField) => {
    const result = validateRow(
      row({ producer: "P", name: "W", quantity: "1", unit_cost: "10", [field]: raw }),
      columnToField,
    );
    expect(result.state).toBe("error");
    if (result.state !== "error") return;
    expect(result.errors.some((e) => e.field === expectedField)).toBe(true);
  });

  it("rejects a quantity above MAX_QUANTITY", () => {
    const result = validateRow(row({ producer: "P", name: "W", quantity: String(MAX_QUANTITY + 1), unit_cost: "10" }), columnToField);
    expect(result.state).toBe("error");
    if (result.state !== "error") return;
    expect(result.errors.some((e) => e.field === "quantity")).toBe(true);
  });

  it("accepts a quantity exactly at MAX_QUANTITY", () => {
    const result = validateRow(row({ producer: "P", name: "W", quantity: String(MAX_QUANTITY), unit_cost: "10" }), columnToField);
    expect(result.state).toBe("valid");
  });

  it("rejects a unit_cost above MAX_UNIT_COST", () => {
    const result = validateRow(row({ producer: "P", name: "W", quantity: "1", unit_cost: String(MAX_UNIT_COST + 1) }), columnToField);
    expect(result.state).toBe("error");
    if (result.state !== "error") return;
    expect(result.errors.some((e) => e.field === "unit_cost")).toBe(true);
  });

  it("rejects a currency not on the allowlist", () => {
    const result = validateRow(row({ producer: "P", name: "W", quantity: "1", unit_cost: "10", currency: "Freedom Bucks" }), columnToField);
    expect(result.state).toBe("error");
    if (result.state !== "error") return;
    expect(result.errors.some((e) => e.field === "currency")).toBe(true);
  });

  it("accepts and normalizes a lowercase currency on the allowlist", () => {
    const result = validateRow(row({ producer: "P", name: "W", quantity: "1", unit_cost: "10", currency: "usd" }), columnToField);
    expect(result.state).toBe("valid");
    if (result.state !== "valid") return;
    expect(result.raw.currency).toBe("USD");
  });
});
