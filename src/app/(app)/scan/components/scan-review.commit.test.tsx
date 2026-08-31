import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { LineItem } from "@/lib/scanner/types";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const { ScanReview } = await import("./scan-review");

/**
 * SD-39 — a scan whose extraction produced nothing still rendered an enabled
 * "Commit to Inventory" button, and `handleCommit` early-returns on
 * `items.length === 0`. Pressing it did nothing at all: no request, no
 * message, no state change. Export CSV was already hidden for exactly this
 * condition; the primary action now says the same thing.
 */
function markup(items: LineItem[]): string {
  return renderToStaticMarkup(
    <ScanReview
      id="scan-1"
      distributor="Reliable Distribution"
      invoiceNumber="INV-1"
      invoiceDate="2026-08-21"
      accuracy={98}
      itemCount={items.length}
      createdAt="2026-08-21T00:00:00.000Z"
      items={items}
      hasImage={false}
    />,
  );
}

const oneItem: LineItem[] = [
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
];

describe("ScanReview commit affordance", () => {
  it("offers Commit to Inventory when there is something to commit", () => {
    const html = markup(oneItem);
    expect(html).toContain("Commit to Inventory");
    expect(html).toContain("Export CSV");
  });

  it("offers no Commit button on a scan with zero line items", () => {
    const html = markup([]);
    expect(html).not.toContain("Commit to Inventory");
    // The comparator the inventory named: Export CSV already hid itself for
    // the same condition, and still does.
    expect(html).not.toContain("Export CSV");
  });
});
