import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const { PricingSection } = await import("./pricing-section");
const { baseRow } = await import("./test-row");

describe("PricingSection", () => {
  it("renders the lightweight fallback line when there are no list prices", () => {
    const html = renderToStaticMarkup(
      <PricingSection
        row={baseRow({ retail_median: 40, current_bottle_price: null, current_glass_price: null })}
        canManage={false}
      />,
    );
    expect(html).toContain("no list prices set");
    expect(html).not.toContain("card-surface");
  });

  it("renders the full card with glass and bottle rows when prices exist", () => {
    const html = renderToStaticMarkup(
      <PricingSection
        row={baseRow({
          retail_median: 40,
          current_bottle_price: 65,
          current_glass_price: 14,
          glass_pour_ml: 150,
        })}
        canManage={false}
      />,
    );
    expect(html).toContain("$14.00");
    expect(html).toContain("$65.00");
    expect(html).toContain("/ bottle");
  });

  it("shows the pricing target override only when canManage and a bottle price exist", () => {
    const managed = renderToStaticMarkup(
      <PricingSection
        row={baseRow({ retail_median: 40, current_bottle_price: 65 })}
        canManage={true}
      />,
    );
    const unmanaged = renderToStaticMarkup(
      <PricingSection
        row={baseRow({ retail_median: 40, current_bottle_price: 65 })}
        canManage={false}
      />,
    );
    expect(managed.length).toBeGreaterThan(unmanaged.length);
  });
});
