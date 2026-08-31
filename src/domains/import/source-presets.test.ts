import { describe, expect, it } from "vitest";
import { HEADER_SYNONYMS, type CanonicalHeader } from "./constants";
import { mapHeader } from "./row-validator";
import {
  SOURCE_PRESET_IDS,
  allSourcePresets,
  detectSourcePreset,
  sourcePreset,
} from "./source-presets";

/**
 * SCAN-03 / decision D1 — source presets over the CSV/XLSX path.
 *
 * The mappings are asserted through `mapHeader`, not against the preset
 * tables directly, because the property that actually matters is what a
 * REAL header row resolves to once HEADER_SYNONYMS has had first refusal.
 */

function fieldsFor(header: string[]): Record<string, CanonicalHeader> {
  const { columnToField } = mapHeader(header);
  const out: Record<string, CanonicalHeader> = {};
  for (const [index, field] of columnToField) out[header[index]] = field;
  return out;
}

describe("preset integrity", () => {
  it("never invents columns for a source whose schema could not be verified", () => {
    for (const preset of allSourcePresets()) {
      if (preset.confidence !== "unverified") continue;
      // The whole safety argument: an unverified preset carries no columns
      // and no signature, so it can neither fire nor mismap.
      expect(Object.keys(preset.columns), `${preset.id} columns`).toHaveLength(0);
      expect(preset.signature, `${preset.id} signature`).toHaveLength(0);
    }
  });

  it("states its provenance for every preset", () => {
    for (const id of SOURCE_PRESET_IDS) {
      expect(sourcePreset(id).provenance.length).toBeGreaterThan(40);
    }
  });

  it("never maps a derived money column to unit_cost", () => {
    // The trap HEADER_SYNONYMS already documents: a quantity-multiplied or
    // market-valued figure imported as a per-bottle cost silently corrupts
    // every cost in the cellar.
    const derived = [
      "total cost",
      "total cost price",
      "case cost",
      "extended cost",
      "total value",
      "valuation",
      "value",
      "on-hand value",
    ];
    for (const preset of allSourcePresets()) {
      for (const column of derived) {
        expect(preset.columns[column], `${preset.id}.${column}`).toBeUndefined();
      }
    }
  });

  it("lets HEADER_SYNONYMS win over every preset column", () => {
    // Rule 1 of source-presets.ts. A preset may only claim a column the
    // generic path was going to ignore.
    for (const preset of allSourcePresets()) {
      for (const [column, field] of Object.entries(preset.columns)) {
        const synonym = HEADER_SYNONYMS[column];
        if (synonym !== undefined) {
          expect(synonym, `${preset.id}.${column} shadows a synonym`).toBe(field);
        }
      }
    }
  });
});

describe("detectSourcePreset", () => {
  it("recognises a CellarTracker export by its own wine id column", () => {
    const header = ["iWine", "Vintage", "Producer", "Wine", "Quantity", "Price"];
    expect(detectSourcePreset(header)).toBe("cellartracker");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(detectSourcePreset(["  IWINE ", "Wine"])).toBe("cellartracker");
  });

  it("returns null for a header it does not recognise", () => {
    expect(detectSourcePreset(["producer", "name", "quantity"])).toBeNull();
    expect(detectSourcePreset([])).toBeNull();
  });

  it("cannot detect a source whose schema was never verified", () => {
    // Vivino publishes no structured CSV export at all; BinWise, BevSpot
    // and Bevrly publish no schema. None may fire on a guess.
    expect(detectSourcePreset(["vivino", "winery", "wine name"])).toBeNull();
    expect(detectSourcePreset(["binwise", "bevspot", "bevrly"])).toBeNull();
  });
});

describe("mapHeader with a realistic export header row", () => {
  it("maps a CellarTracker bottle-view export", () => {
    // Columns taken from CellarTracker's published export (verified
    // 2026-08-30). Location/Bin/Size only appear in the bottle-based view.
    const header = [
      "iWine",
      "Vintage",
      "Producer",
      "Wine",
      "Varietal",
      "MasterVarietal",
      "Country",
      "Region",
      "SubRegion",
      "Appellation",
      "Location",
      "Bin",
      "Size",
      "Currency",
      "Quantity",
      "Price",
    ];
    const { detectedSource, missingRequired } = mapHeader(header);
    expect(detectedSource).toBe("cellartracker");
    expect(missingRequired).toEqual([]);

    const fields = fieldsFor(header);
    expect(fields).toMatchObject({
      Vintage: "vintage",
      Producer: "producer",
      Wine: "name",
      Varietal: "varietal",
      Country: "country",
      Region: "region",
      Location: "bin",
      Size: "size_ml",
      Currency: "currency",
      Quantity: "quantity",
      Price: "unit_cost",
    });
    // First column wins per canonical field, so the preset's own
    // Appellation/SubRegion never displace the plain Region above.
    expect(fields.SubRegion).toBeUndefined();
    expect(fields.MasterVarietal).toBeUndefined();
    // iWine is a detection signature, not a field this importer has.
    expect(fields.iWine).toBeUndefined();
  });

  it("fills CellarTracker's gaps when the plain columns are absent", () => {
    const header = ["iWine", "Wine", "TotalQuantity", "MasterVarietal", "Appellation"];
    expect(fieldsFor(header)).toEqual({
      Wine: "name",
      TotalQuantity: "quantity",
      MasterVarietal: "varietal",
      Appellation: "region",
    });
  });

  it("carries an unrecognised beverage-inventory export on the generic profile", () => {
    // Not any vendor's schema — the column labels that recur across the
    // category. This is what actually carries a BinWise/BevSpot/Bevrly
    // export today, and it is stated as such rather than dressed up as a
    // vendor mapping.
    const header = [
      "Item Name",
      "Brand",
      "Vintage",
      "On Hand",
      "Bottle Cost",
      "Storage Location",
      "Container Size",
    ];
    const { detectedSource, missingRequired } = mapHeader(header);
    expect(detectedSource).toBeNull();
    expect(missingRequired).toEqual([]);
    expect(fieldsFor(header)).toEqual({
      "Item Name": "name",
      Brand: "producer",
      Vintage: "vintage",
      "On Hand": "quantity",
      "Bottle Cost": "unit_cost",
      "Storage Location": "bin",
      "Container Size": "size_ml",
    });
  });

  it("still reports the required columns a file genuinely lacks", () => {
    const { missingRequired } = mapHeader(["Producer", "Region"]);
    expect(missingRequired).toEqual(["name", "quantity"]);
  });
});
