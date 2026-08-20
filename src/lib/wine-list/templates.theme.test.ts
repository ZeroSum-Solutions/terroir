import { describe, expect, it } from "vitest";
import { VALID_THEME } from "@/test/fixtures/menu-theme";
import { renderTemplate } from "./templates";

const LIST = {
  name: "Dinner",
  restaurantName: "Terroir Test",
  sections: [],
};

describe("renderTemplate theme source", () => {
  it("keeps the existing classic appearance when theme is null", () => {
    const html = renderTemplate("classic", LIST, null);
    expect(html).toContain("background: #F9F6F0");
    expect(html).toContain("color: #1A1A1A");
    expect(html).not.toContain("data-menu-theme");
  });

  it("applies matching structured theme tokens to PDF HTML", () => {
    const html = renderTemplate("classic", LIST, VALID_THEME);
    expect(html).toContain('data-menu-theme="Cellar Ink"');
    expect(html).toContain("background: #FFFFFF");
    expect(html).toContain("color: #111111");
    expect(html).toContain("font-family: 'Cormorant Garamond'");
    expect(html).not.toContain("fonts.googleapis.com");
  });
});
