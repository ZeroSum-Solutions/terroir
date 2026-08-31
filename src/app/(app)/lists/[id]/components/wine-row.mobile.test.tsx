import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WineRow } from "./wine-row";

const item = {
  id: "item-1",
  section_id: "section-1",
  wine_id: "wine-1",
  position: 0,
  glass_price: 18,
  bottle_price: 72,
  glass_pour_ml: 148,
  pour_size_mode: "fixed" as const,
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
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** The `md:hidden` card — the only one of the two layouts a phone sees. */
async function renderMobileCard(): Promise<HTMLElement> {
  await act(async () =>
    root.render(
      <WineRow
        item={item}
        onDelete={vi.fn()}
        onPriceChange={vi.fn()}
        onPourChange={vi.fn()}
        onNameChange={vi.fn()}
        onBlurbChange={vi.fn()}
        onHiddenChange={vi.fn()}
      />,
    ),
  );
  return [...container.querySelectorAll<HTMLElement>("div")].find((node) =>
    node.className.split(" ").includes("md:hidden"),
  )!;
}

describe("WineRow mobile card", () => {
  it("keeps every mobile control at least 44px tall", async () => {
    const mobile = await renderMobileCard();

    const controls = [
      mobile.querySelector('a[href="/cellar?wine=wine-1"]'),
      mobile.querySelector('[aria-label="Rename Estate Red"]'),
      mobile.querySelector('[aria-label="Remove Estate Red"]'),
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

  it("opens the wine when the card is tapped, picture included", async () => {
    const mobile = await renderMobileCard();
    const link = mobile.querySelector<HTMLAnchorElement>(
      'a[href="/cellar?wine=wine-1"]',
    )!;

    expect(link.textContent).toContain("Demo Cellars");
    // The thumbnail travels with the tap target rather than sitting beside it.
    expect(link.querySelector('[aria-hidden="true"], img')).not.toBeNull();
  });

  it("keeps the rename reachable on its own control", async () => {
    const mobile = await renderMobileCard();
    expect(
      container.querySelector('input[aria-label="Display name for Estate Red"]'),
    ).toBeNull();

    const rename = mobile.querySelector<HTMLButtonElement>(
      '[aria-label="Rename Estate Red"]',
    )!;
    await act(async () => rename.click());

    expect(
      container.querySelector('input[aria-label="Display name for Estate Red"]'),
    ).not.toBeNull();
  });
});
