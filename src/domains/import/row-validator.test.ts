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
    expect(missingRequired).toEqual(["name", "quantity"]);
  });

  // Real-world exports (first seen 2026-08-27: a partner's consolidated
  // inventory) rarely follow the template: producer lives inside the wine
  // name, cost is "Cost Price" with dollar strings, size is "Volume".
  it("maps a real-world header with no producer column", () => {
    const { columnToField, missingRequired } = mapHeader([
      "Vintage",
      "Volume",
      "Wine Name",
      "Quantity",
      "Cost Price ",
      "Total Cost Price",
    ]);
    expect(missingRequired).toEqual([]);
    expect(columnToField.get(0)).toBe("vintage");
    expect(columnToField.get(1)).toBe("size_ml");
    expect(columnToField.get(2)).toBe("name");
    expect(columnToField.get(3)).toBe("quantity");
    expect(columnToField.get(4)).toBe("unit_cost");
    // "Total Cost Price" is a derived column, deliberately NOT mapped —
    // importing it as unit_cost would multiply every cost by quantity.
    expect(columnToField.has(5)).toBe(false);
  });

  it("maps grape/appellation synonyms", () => {
    const { columnToField } = mapHeader(["Wine Name", "Quantity", "Grapes", "Appellation"]);
    expect(columnToField.get(2)).toBe("varietal");
    expect(columnToField.get(3)).toBe("region");
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

  it("requires name and quantity but tolerates a missing producer", () => {
    const result = validateRow(["", "", "2020", "", "24.50"], columnToField);
    expect(result.state).toBe("error");
    if (result.state !== "error") return;
    const fields = result.errors.map((e) => e.field);
    expect(fields).toEqual(expect.arrayContaining(["name", "quantity"]));
    expect(fields).not.toContain("producer");
  });

  it("accepts a producer-less row with producer persisted as empty string, never null", () => {
    // apply_import_batch_chunk_v2 (0108) inserts raw->>'producer' into
    // wines.producer, which is NOT NULL (0002) — a JSON null here would
    // fail every such row at apply time.
    const result = validateRow(["", "A.F. Gros Richebourg Grand Cru", "2018", "3", "678.00"], columnToField);
    expect(result.state).toBe("valid");
    if (result.state !== "valid") return;
    expect(result.producer).toBe("");
    expect(result.raw.producer).toBe("");
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

  // P2 NV fix (docs/plans/2026-08-23-p2-identity-spine.md §5): literal
  // "NV" is the identity fact "no vintage," not malformed data — it
  // predates this importer's NV acceptance.
  it("accepts the literal vintage text 'NV' as a valid row with a null vintage", () => {
    const result = validateRow(["Domaine A", "Cuvee 1", "NV", "6", "10"], columnToField);
    expect(result.state).toBe("valid");
    if (result.state !== "valid") return;
    expect(result.raw.vintage).toBeNull();
  });

  it("still rejects vintage text that merely resembles NV-adjacent noise", () => {
    for (const bad of ["circa 1998", "'98", "202X", "not sure", "19-something", "MCMXCIX"]) {
      const result = validateRow(["Domaine A", "Cuvee 1", bad, "6", "10"], columnToField);
      expect(result.state).toBe("error");
      if (result.state !== "error") continue;
      expect(result.errors.some((e) => e.field === "vintage")).toBe(true);
    }
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
    // "750ml" itself became a recognized volume literal (2026-08-27) —
    // whole-string matched, so still no silent coercion; actual trailing
    // garbage stays a field error.
    ["size_ml", "750mlx", "size_ml"],
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

// Real-world value formats (2026-08-27): spreadsheet exports carry costs
// like "$678.00" / "$2,034.00" and volumes like "1.5L" / "750ml". These
// are tolerated at parse time; the strict whole-string literal gates
// (C18) still apply to whatever survives normalization.
describe("validateRow — real-world value tolerance", () => {
  const { columnToField } = map();
  const base = (unitCost: string) => ["P", "W", "2020", "1", unitCost];

  it.each([
    ["$678.00", "678.00"],
    ["$2,034.00", "2034.00"],
    ["123,456.89", "123456.89"],
    ["£1,200.50", "1200.50"],
    ["45,50", "45.50"],
    ["1,000,000", "1000000.00"],
  ])("normalizes cost %s to %s", (input, expected) => {
    const result = validateRow(base(input), columnToField);
    expect(result.state).toBe("valid");
    if (result.state !== "valid") return;
    expect(result.raw.unit_cost).toBe(expected);
    expect(result.costMissing).toBe(false);
  });

  // Sol audit (2026-08-27) finding 2: with decimal commas supported, a
  // LONE three-digit comma group with no decimal dot is ambiguous —
  // "1,234" is 1234 in the US and 1.234 in a decimal-comma locale, a
  // ~1000x cost difference. It must be rejected, never guessed.
  it.each([["1,234"], ["€1,234"], ["$9,999"]])(
    "rejects the ambiguous lone-comma amount %s outright",
    (input) => {
      const result = validateRow(base(input), columnToField);
      expect(result.state).toBe("error");
      if (result.state !== "error") return;
      expect(result.errors.some((e) => e.field === "unit_cost")).toBe(true);
    },
  );

  it("accepts a lone comma group once a decimal dot disambiguates it", () => {
    const result = validateRow(base("€1,234.00"), columnToField);
    expect(result.state).toBe("valid");
    if (result.state !== "valid") return;
    expect(result.raw.unit_cost).toBe("1234.00");
    expect(result.raw.currency).toBe("EUR");
  });

  it("infers EUR from a € symbol when no currency column is present", () => {
    const result = validateRow(base("€45.00"), columnToField);
    expect(result.state).toBe("valid");
    if (result.state !== "valid") return;
    expect(result.raw.currency).toBe("EUR");
    expect(result.raw.unit_cost).toBe("45.00");
  });

  it("infers GBP and JPY from their symbols", () => {
    const gbp = validateRow(base("£1,200.50"), columnToField);
    expect(gbp.state).toBe("valid");
    if (gbp.state !== "valid") return;
    expect(gbp.raw.currency).toBe("GBP");
    const jpy = validateRow(base("¥1200"), columnToField);
    expect(jpy.state).toBe("valid");
    if (jpy.state !== "valid") return;
    expect(jpy.raw.currency).toBe("JPY");
    expect(jpy.raw.unit_cost).toBe("1200.00");
  });

  it("never infers a currency from the ambiguous $ symbol", () => {
    const result = validateRow(base("$678.00"), columnToField);
    expect(result.state).toBe("valid");
    if (result.state !== "valid") return;
    expect(result.raw.currency).toBeNull();
  });

  it("lets an explicit currency column win over a cost symbol", () => {
    const { columnToField: full } = mapHeader(["Producer", "Wine", "Vintage", "Qty", "Unit Cost", "Currency"]);
    const result = validateRow(["P", "W", "2020", "1", "€45.00", "CHF"], full);
    expect(result.state).toBe("valid");
    if (result.state !== "valid") return;
    expect(result.raw.currency).toBe("CHF");
  });

  it.each([["$-5"], ["-$5"], ["12,34,56"], ["$1,23.00"], ["N/A"], ["$"]])(
    "rejects malformed cost %s as a validation error",
    (input) => {
      const result = validateRow(base(input), columnToField);
      expect(result.state).toBe("error");
      if (result.state !== "error") return;
      expect(result.errors.some((e) => e.field === "unit_cost")).toBe(true);
    },
  );

  const sized = (volume: string) => {
    const { columnToField: withVolume } = mapHeader(["Producer", "Wine", "Vintage", "Qty", "Unit Cost", "Volume"]);
    return validateRow(["P", "W", "2020", "1", "10", volume], withVolume);
  };

  it.each([
    ["750ml", "750"],
    ["750 ml", "750"],
    ["75cl", "750"],
    ["1.5L", "1500"],
    ["0.375l", "375"],
    ["750", "750"],
    // Sol audit (2026-08-27) finding 3: unit conversion must be exact
    // decimal arithmetic — binary floats compute 1.001 * 1000 as
    // 1000.9999999999999 and wrongly reject an exactly-whole 1001 ml.
    ["1.001L", "1001"],
    ["30000", "30000"],
  ])("parses volume %s as %s ml", (input, expected) => {
    const result = sized(input);
    expect(result.state).toBe("valid");
    if (result.state !== "valid") return;
    expect(result.raw.size_ml).toBe(expected);
  });

  it("defaults a blank volume to 750 ml", () => {
    const result = sized("");
    expect(result.state).toBe("valid");
    if (result.state !== "valid") return;
    expect(result.raw.size_ml).toBe("750");
  });

  // Oversized values (Sol audit finding 3): parseInt precision loss
  // (9007199254740993 -> ...992), Infinity from very long digit strings,
  // and int4 overflow at the SQL cast (2147483648) were all silently
  // accepted before the bound. All must be rejected at validation.
  it.each([
    ["magnum"],
    ["1.5013L"],
    ["0ml"],
    ["-750ml"],
    // Deliberate contraction (Sol round-2 WARN 1): a sign on a bottle
    // size is garbage; the old INTEGER_LITERAL path accepted "+750".
    ["+750"],
    ["100001"],
    ["2147483648"],
    ["9007199254740993"],
    ["101L"],
    [`1${"0".repeat(400)}`],
  ])("rejects unparseable or out-of-bounds volume %s", (input) => {
    const result = sized(input);
    expect(result.state).toBe("error");
    if (result.state !== "error") return;
    expect(result.errors.some((e) => e.field === "size_ml")).toBe(true);
  });
});
