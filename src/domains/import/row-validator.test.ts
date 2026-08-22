import { describe, expect, it } from "vitest";
import { mapHeader, validateRow } from "./row-validator";

const HEADER = ["Producer", "Wine", "Vintage", "Qty", "Unit Cost"];

function map() {
  return mapHeader(HEADER);
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
