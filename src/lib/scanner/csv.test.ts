import { describe, expect, it } from "vitest";
import { toCsv } from "./csv";
import type { LineItem } from "./types";

function item(overrides: Partial<LineItem> = {}): LineItem {
  return {
    id: "row-1",
    name: "Pinot Noir",
    producer: "Domaine Test",
    vintage: 2020,
    varietal: "Pinot Noir",
    region: "Burgundy",
    qty: 6,
    unitCost: 42,
    confidence: 0.95,
    ...overrides,
  };
}

describe("toCsv", () => {
  it("prepends a UTF-8 BOM so Excel decodes the file as UTF-8", () => {
    const out = toCsv([]);
    expect(out.charCodeAt(0)).toBe(0xfeff);
  });

  it("uses CRLF row separators per RFC 4180", () => {
    const out = toCsv([item()]);
    const body = out.slice(1);
    const lines = body.split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Wine,Producer,/);
  });

  it("neutralizes leading formula characters to prevent CSV injection", () => {
    const out = toCsv([
      item({ producer: '=HYPERLINK("http://x","x")' }),
      item({ name: "+1+1" }),
      item({ region: "-2" }),
      item({ varietal: "@SUM(A1)" }),
    ]);
    // Values now begin with a single quote; the producer field also
    // contains a comma so it is quoted, with the leading quote inside.
    expect(out).toContain('"\'=HYPERLINK(""http://x"",""x"")"');
    expect(out).toContain("'+1+1");
    expect(out).toContain("'-2");
    expect(out).toContain("'@SUM(A1)");
  });

  it("leaves benign values untouched", () => {
    const out = toCsv([item({ producer: "Domaine de la Roman\u00e9e-Conti" })]);
    expect(out).toContain("Domaine de la Roman\u00e9e-Conti");
    expect(out).not.toContain("'Domaine");
  });
});
