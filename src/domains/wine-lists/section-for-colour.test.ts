import { describe, expect, it } from "vitest";
import { DEFAULT_SECTIONS } from "@/lib/wine-list/types";
import { sectionIdForColour } from "./section-for-colour";

/**
 * The sections a new wine list actually ships with. Built from
 * DEFAULT_SECTIONS rather than a hand-copied literal, so if that list ever
 * changes shape these tests fail instead of quietly testing fiction.
 */
const DEFAULTS = DEFAULT_SECTIONS.map((name) => ({ id: `sec-${name}`, name }));

describe("sectionIdForColour — against the real default sections", () => {
  it.each([
    ["sparkling", "sec-Sparkling"],
    ["white", "sec-White"],
    ["rose", "sec-Rosé"],
    ["red", "sec-Red"],
    // The default template folds two colours into one section.
    ["dessert", "sec-Dessert & Fortified"],
    ["fortified", "sec-Dessert & Fortified"],
  ])("routes %s to its section", (colour, expected) => {
    expect(sectionIdForColour(colour, DEFAULTS)).toBe(expected);
  });

  it("covers every colour the enrichment can write", () => {
    // Regression guard: an unmatched colour silently falls back to whichever
    // section was open, which is the bug this function exists to prevent.
    const COLOURS = ["red", "white", "sparkling", "rose", "dessert", "fortified"];
    for (const colour of COLOURS) {
      expect(sectionIdForColour(colour, DEFAULTS), `colour ${colour}`).not.toBeNull();
    }
  });
});

describe("sectionIdForColour — matching rules", () => {
  it("matches 'rose' against the accented section name 'Rosé'", () => {
    expect(sectionIdForColour("rose", [{ id: "s", name: "Rosé" }])).toBe("s");
  });

  it("matches an accented colour against an unaccented section name", () => {
    expect(sectionIdForColour("rosé", [{ id: "s", name: "Rose" }])).toBe("s");
  });

  it("ignores casing and surrounding whitespace on both sides", () => {
    expect(sectionIdForColour("  RED  ", [{ id: "s", name: "  red  " }])).toBe("s");
  });

  it.each([
    ["Dessert & Fortified", "fortified"],
    ["Dessert and Fortified", "fortified"],
    ["Dessert / Fortified", "fortified"],
    ["Dessert, Fortified", "fortified"],
    ["Dessert + Fortified", "fortified"],
    ["Sparkling & Champagne", "sparkling"],
  ])("splits %s on its separator so %s matches", (name, colour) => {
    expect(sectionIdForColour(colour, [{ id: "s", name }])).toBe("s");
  });

  it("prefers a section named exactly for the colour over a combined one", () => {
    const sections = [
      { id: "combined", name: "Dessert & Fortified" },
      { id: "specific", name: "Dessert" },
    ];
    expect(sectionIdForColour("dessert", sections)).toBe("specific");
    // ...and the combined section still catches the colour it alone covers.
    expect(sectionIdForColour("fortified", sections)).toBe("combined");
  });

  it("does not match a colour that is merely a word inside a section name", () => {
    // "Red Burgundy" must not swallow every red — that is the same class of
    // misfiling this function exists to prevent.
    expect(sectionIdForColour("red", [{ id: "s", name: "Red Burgundy" }])).toBeNull();
    expect(sectionIdForColour("white", [{ id: "s", name: "White Burgundy" }])).toBeNull();
  });

  it("does not match pluralised section names", () => {
    expect(sectionIdForColour("red", [{ id: "s", name: "Reds" }])).toBeNull();
  });

  it("returns null when the wine has no colour", () => {
    // A wine created from the LWIN catalog moments ago has no colour yet.
    expect(sectionIdForColour(null, DEFAULTS)).toBeNull();
    expect(sectionIdForColour(undefined, DEFAULTS)).toBeNull();
    expect(sectionIdForColour("", DEFAULTS)).toBeNull();
    expect(sectionIdForColour("   ", DEFAULTS)).toBeNull();
  });

  it("returns null when no section corresponds to the colour", () => {
    expect(sectionIdForColour("sparkling", [{ id: "s", name: "Red" }])).toBeNull();
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
