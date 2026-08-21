import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const { EnrichCellarButton } = await import("./enrich-cellar-button");
const { RefreshRetailButton } = await import("./refresh-retail-button");

describe("Insights refresh actions", () => {
  it("gives both owner refresh actions 44px touch targets", () => {
    document.body.innerHTML = renderToStaticMarkup(
      <>
        <EnrichCellarButton />
        <RefreshRetailButton />
      </>,
    );

    const buttons = document.querySelectorAll("button");
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button.className).toContain("min-h-11");
    }
  });
});
