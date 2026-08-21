import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const { ScanReview } = await import("./scan-review");
const { ReExtractButton } = await import("../[id]/components/re-extract-button");

function hasTouchTargetClass(element: Element | null) {
  return /(?:^|\s)(?:h-11|min-h-11)(?:\s|$)/.test(
    element?.getAttribute("class") ?? "",
  );
}

describe("scan review mobile controls", () => {
  it("keeps every essential header action at least 44px high", () => {
    document.body.innerHTML = renderToStaticMarkup(
      <>
        <ReExtractButton scanId="scan-1" />
        <ScanReview
          id="scan-1"
          distributor="Reliable Distribution"
          invoiceNumber="INV-1"
          invoiceDate="2026-08-21"
          accuracy={98}
          itemCount={1}
          createdAt="2026-08-21T00:00:00.000Z"
          items={[
            {
              id: "item-1",
              name: "Reserve Red",
              producer: "House Producer",
              vintage: 2022,
              varietal: "Cabernet Sauvignon",
              region: "Napa Valley",
              qty: 6,
              unitCost: 18,
              confidence: 0.98,
            },
          ]}
          hasImage={false}
        />
      </>,
    );

    expect(
      hasTouchTargetClass(
        document.querySelector('button[title^="Re-run Claude extraction"]'),
      ),
    ).toBe(true);
    expect(
      hasTouchTargetClass(document.querySelector('a[href="/scan"]')),
    ).toBe(true);
    expect(
      hasTouchTargetClass(
        document.querySelector('button[title="Download line items as CSV"]'),
      ),
    ).toBe(true);
  });
});
