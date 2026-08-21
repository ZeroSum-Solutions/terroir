import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WineRow } from "./wine-row";

describe("WineRow mobile touch targets", () => {
  it("keeps every mobile editing control at least 44px tall", () => {
    document.body.innerHTML = renderToStaticMarkup(
      <WineRow
        item={{
          id: "item-1",
          section_id: "section-1",
          wine_id: "wine-1",
          position: 0,
          glass_price: 18,
          bottle_price: 72,
          glass_pour_ml: 148,
          pour_size_mode: "fixed",
          tasting_note: null,
          name_override: null,
          blurb: null,
          hidden: false,
          wines: {
            id: "wine-1",
            name: "Estate Red",
            producer: "Demo Cellars",
            vintage: 2022,
            varietal: "Cabernet Sauvignon",
            region: "Napa Valley",
          },
        }}
        onDelete={vi.fn()}
        onPriceChange={vi.fn()}
        onPourChange={vi.fn()}
        onNameChange={vi.fn()}
        onBlurbChange={vi.fn()}
        onHiddenChange={vi.fn()}
      />,
    );
    const mobile = [...document.querySelectorAll<HTMLElement>("div")].find(
      (node) => node.className.split(" ").includes("md:hidden"),
    )!;

    const controls = [
      [...mobile.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Demo Cellars"),
      ),
      mobile.querySelector('[aria-label="Options for Estate Red"]'),
      mobile.querySelector('[aria-label="Pour size in ml for Estate Red"]'),
      [...mobile.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Visible on list"),
      ),
    ];
    for (const control of controls) {
      expect(control).not.toBeNull();
      expect(control?.className).toMatch(/(?:^|\s)(?:h-11|min-h-11)(?:\s|$)/);
    }
    mobile.querySelectorAll("input[type=radio]").forEach((radio) => {
      expect(radio.closest("label")?.className).toContain("min-h-11");
    });
  });
});
