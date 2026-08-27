import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AtlasFacetRow } from "@/lib/atlas/aggregate";
import { AtlasShell } from "./atlas-shell";

function wine(overrides: Partial<AtlasFacetRow>): AtlasFacetRow {
  return {
    id: "w1",
    name: "Test Wine",
    producer: "Test Producer",
    vintage: 2018,
    varietal: "Shiraz",
    region: "Burgundy",
    country: "France",
    sealed_count: 0,
    ...overrides,
  } as AtlasFacetRow;
}

describe("AtlasShell — open-bottle-only presence (Sol round-2/3)", () => {
  it("keeps an open-bottle-only country visible and labeled on map and list", () => {
    const html = renderToStaticMarkup(
      <AtlasShell rows={[wine({ sealed_count: 0, hasOpenBottle: true })]} restaurantName="Test" />,
    );
    // Both the SVG path AND the country chip <button> expose the country
    // with the explicit open-bottle wording (the chip assertion is scoped
    // to a <button> element so the map path's identical label can't
    // satisfy it), never a bare misleading "0 bottles".
    expect(html).toMatch(/<path[^>]*aria-label="France, open bottle only"/);
    expect(html).toMatch(/<button[^>]*aria-label="France, open bottle only"/);
    expect(html).not.toContain("0 bottles");
  });

  it("labels sealed-stock countries with their bottle count", () => {
    const html = renderToStaticMarkup(
      <AtlasShell rows={[wine({ sealed_count: 7, hasOpenBottle: false })]} restaurantName="Test" />,
    );
    expect(html).toMatch(/<button[^>]*aria-label="France, 7 bottles"/);
  });

  it("renders the empty state when no row has cellar presence", () => {
    const html = renderToStaticMarkup(
      <AtlasShell rows={[wine({ sealed_count: 0, hasOpenBottle: false })]} restaurantName="Test" />,
    );
    expect(html).not.toContain('aria-label="France');
  });
});
