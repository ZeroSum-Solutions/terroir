import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WineThumb, wineInitials, wineTint } from "./wine-thumb";

describe("wineInitials", () => {
  it("takes the producer's first two words, which is how a cellar is grouped", () => {
    expect(wineInitials("Domaine Leflaive", "Puligny-Montrachet")).toBe("DL");
  });

  it("uses one letter for a single-word producer", () => {
    expect(wineInitials("Krug", "Grande Cuvée")).toBe("K");
  });

  it("falls back to the wine name when there is no producer", () => {
    expect(wineInitials("", "Barolo Riserva")).toBe("BR");
    expect(wineInitials(null, "Barolo Riserva")).toBe("BR");
  });

  it("returns nothing rather than a meaningless glyph when both are empty", () => {
    expect(wineInitials(null, null)).toBe("");
    expect(wineInitials("   ", "")).toBe("");
  });

  it("keeps accented initials intact rather than mangling them", () => {
    expect(wineInitials("Émilien Ölberg", null)).toBe("ÉÖ");
  });

  it("skips punctuation-only words instead of turning them into initials", () => {
    expect(wineInitials("Château — Margaux", null)).toBe("CM");
  });

  it("counts an astral first character as one letter, not half of a surrogate pair", () => {
    expect(Array.from(wineInitials("𝒜lpha Beta", null))).toHaveLength(2);
  });
});

describe("wineTint", () => {
  it("tints by wine colour however it was cased or spaced", () => {
    expect(wineTint("Red")).toEqual(wineTint("  red "));
  });

  it("gives sparkling its own tint, distinct from red", () => {
    expect(wineTint("Sparkling")).not.toEqual(wineTint("red"));
  });

  it("falls back to neutral for an unknown or missing colour rather than guessing", () => {
    expect(wineTint("orange")).toEqual(wineTint(null));
    expect(wineTint(undefined)).toEqual(wineTint(""));
  });
});

describe("WineThumb", () => {
  it("renders the picture when the wine has one", () => {
    const markup = renderToStaticMarkup(
      <WineThumb src="https://cdn.example/w.jpg" producer="Krug" name="Grande Cuvée" size={36} />,
    );
    expect(markup).toContain("cdn.example");
    expect(markup).toContain("<img");
  });

  it("renders a stand-in rather than nothing when the wine has no picture", () => {
    // Rendering nothing was the actual defect: a list mixing rows that had a
    // thumbnail with rows that had no element at all reads as broken.
    const markup = renderToStaticMarkup(
      <WineThumb src={null} producer="Domaine Leflaive" name="Puligny" colour="white" size={36} />,
    );
    expect(markup).not.toContain("<img");
    expect(markup).toContain("DL");
    expect(markup).toContain('data-wine-image-fallback="true"');
  });

  it("reserves the same box whether or not there is a picture", () => {
    const withImage = renderToStaticMarkup(
      <WineThumb src="https://cdn.example/w.jpg" producer="Krug" name="G" size={40} />,
    );
    const without = renderToStaticMarkup(
      <WineThumb src={null} producer="Krug" name="G" size={40} />,
    );
    expect(withImage).toContain("width:40px");
    expect(without).toContain("width:40px");
    expect(withImage).toContain("height:40px");
    expect(without).toContain("height:40px");
  });

  it("requests the image at 2x so a 36px thumbnail is not soft on a retina screen", () => {
    const markup = renderToStaticMarkup(
      <WineThumb src="https://cdn.example/w.jpg" producer="Krug" name="G" size={36} />,
    );
    expect(markup).toContain('width="72"');
    expect(markup).toContain('height="72"');
  });

  it("hides the stand-in from screen readers — the name is already in the row", () => {
    const markup = renderToStaticMarkup(
      <WineThumb src={null} producer="Krug" name="G" size={36} />,
    );
    expect(markup).toContain('aria-hidden="true"');
  });

  it("gives the picture an empty alt for the same reason", () => {
    const markup = renderToStaticMarkup(
      <WineThumb src="https://cdn.example/w.jpg" producer="Krug" name="G" size={36} />,
    );
    expect(markup).toContain('alt=""');
  });

  it("tints the stand-in by wine colour", () => {
    const red = renderToStaticMarkup(
      <WineThumb src={null} producer="Krug" name="G" colour="red" size={36} />,
    );
    const sparkling = renderToStaticMarkup(
      <WineThumb src={null} producer="Krug" name="G" colour="sparkling" size={36} />,
    );
    expect(red).not.toBe(sparkling);
  });

  it("still reserves the box for a wine with neither picture nor name", () => {
    const markup = renderToStaticMarkup(
      <WineThumb src={null} producer={null} name={null} size={36} />,
    );
    expect(markup).toContain("width:36px");
  });
});
