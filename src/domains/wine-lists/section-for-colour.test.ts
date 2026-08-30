import { describe, expect, it } from "vitest";
import { sectionIdForColour } from "./section-for-colour";

/** The six sections a wine list ships with, as seen in the Lists editor. */
const SECTIONS = [
  { id: "sec-sparkling", name: "Sparkling" },
  { id: "sec-white", name: "White" },
  { id: "sec-rose", name: "Rosé" },
  { id: "sec-red", name: "Red" },
  { id: "sec-dessert", name: "Dessert" },
  { id: "sec-fortified", name: "Fortified" },
];

describe("sectionIdForColour", () => {
  it.each([
    ["red", "sec-red"],
    ["white", "sec-white"],
    ["sparkling", "sec-sparkling"],
    ["rose", "sec-rose"],
    ["dessert", "sec-dessert"],
    ["fortified", "sec-fortified"],
  ])("maps the stored colour %s onto its section", (colour, expected) => {
    expect(sectionIdForColour(colour, SECTIONS)).toBe(expected);
  });

  it("matches 'rose' against the accented section name 'Rosé'", () => {
    // The enrichment stores colours unaccented; the section label carries the
    // accent back. Without diacritic folding these never compare equal.
    expect(sectionIdForColour("rose", SECTIONS)).toBe("sec-rose");
  });

  it("matches an accented colour against an unaccented section name", () => {
    expect(sectionIdForColour("rosé", [{ id: "s", name: "Rose" }])).toBe("s");
  });

  it("ignores casing and surrounding whitespace on both sides", () => {
    expect(sectionIdForColour("  RED  ", [{ id: "s", name: "  red  " }])).toBe("s");
  });

  it("returns null when the wine has no colour", () => {
    // A wine created from the LWIN catalog moments ago has no colour yet.
    expect(sectionIdForColour(null, SECTIONS)).toBeNull();
    expect(sectionIdForColour(undefined, SECTIONS)).toBeNull();
    expect(sectionIdForColour("", SECTIONS)).toBeNull();
    expect(sectionIdForColour("   ", SECTIONS)).toBeNull();
  });

  it("returns null when no section corresponds to the colour", () => {
    // A list with only a Red section gets no suggestion for a champagne.
    expect(sectionIdForColour("sparkling", [{ id: "s", name: "Red" }])).toBeNull();
  });

  it("does not match compound or pluralised section names", () => {
    // Deliberate: guessing at "Sparkling & Champagne" risks pre-filing a wine
    // into the wrong section, which is the bug this function exists to fix.
    expect(sectionIdForColour("sparkling", [{ id: "s", name: "Sparkling & Champagne" }])).toBeNull();
    expect(sectionIdForColour("red", [{ id: "s", name: "Reds" }])).toBeNull();
  });

  it("returns null for an empty section list", () => {
    expect(sectionIdForColour("red", [])).toBeNull();
  });

  it("picks the first match when a list has duplicate section names", () => {
    const dupes = [
      { id: "first", name: "Red" },
      { id: "second", name: "Red" },
    ];
    expect(sectionIdForColour("red", dupes)).toBe("first");
  });
});
