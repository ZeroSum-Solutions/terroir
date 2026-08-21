import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  router: { push: vi.fn(), refresh: vi.fn() },
}));

vi.mock("@/lib/auth-context", () => ({
  getAuthContext: (...args: unknown[]) => mocks.getAuthContext(...args),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => mocks.router,
}));

const { default: PriceComparisonPage } = await import("./page");

type QueryResult = { data: unknown[] | null; error: unknown };

function makeSupabase(results: Record<string, QueryResult>) {
  return {
    from: vi.fn((table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        not: () => chain,
        then: (
          resolve: (value: QueryResult) => unknown,
          reject?: (reason: unknown) => unknown,
        ) =>
          Promise.resolve(
            results[table] ?? { data: [], error: null },
          ).then(resolve, reject),
      };
      return chain;
    }),
  };
}

function authenticate(results: Record<string, QueryResult>) {
  mocks.getAuthContext.mockResolvedValue({
    user: { id: "user-1" },
    userRole: "owner",
    restaurantId: "restaurant-1",
    restaurantName: "House",
    supabase: makeSupabase(results),
  });
}

function renderPage(node: React.ReactNode) {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(node);
  return container;
}

const inventoryItem = {
  unit_cost: 18,
  quantity: 6,
  wine_id: "wine-1",
  wines: {
    id: "wine-1",
    name: "Reserve Red",
    producer: "House Producer",
    vintage: 2022,
    varietal: "Cabernet Sauvignon",
    retail_median: null,
    retail_min: null,
    retail_max: null,
    enrichment_metadata: null,
    overpaid_flag: false,
  },
  invoice_scan_id: "scan-1",
  invoice_scans: {
    distributor_name: "Reliable Distribution",
    invoice_date: "2026-08-19",
  },
};

describe("PriceComparisonPage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws an inventory_items query failure instead of presenting no pricing data", async () => {
    const error = new Error("forced query failure");
    authenticate({
      inventory_items: { data: null, error },
      wines: { data: [], error: null },
    });

    await expect(
      PriceComparisonPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toBe(error);
  });

  it("renders the genuine empty panel when inventory_items succeeds with zero rows", async () => {
    authenticate({
      inventory_items: { data: [], error: null },
      wines: { data: [], error: null },
    });

    const container = renderPage(
      await PriceComparisonPage({ searchParams: Promise.resolve({}) }),
    );
    const emptyPanel = container.querySelector(
      '[aria-label="Scan invoices to compare prices"]',
    );
    const scannerLink = emptyPanel?.querySelector<HTMLAnchorElement>(
      'a[href="/scan"]',
    );

    expect(emptyPanel).not.toBeNull();
    expect(emptyPanel?.textContent).toContain(
      "Once you scan invoices from multiple distributors, price comparisons will appear here.",
    );
    expect(scannerLink?.matches("a[href]")).toBe(true);
    expect(scannerLink && isHiddenFromAccessibility(scannerLink)).toBe(false);
    expect(scannerLink && getAccessibleName(scannerLink)).toBe("Go to scanner");
    expect(scannerLink?.className).toMatch(
      /(?:^|\s)(?:h-11|min-h-11)(?:\s|$)/,
    );
  });

  it("uses derived zero comparisons for genuine empty pricing even when raw inventory is non-empty", async () => {
    authenticate({
      inventory_items: {
        data: [{ ...inventoryItem, wines: null }],
        error: null,
      },
      wines: { data: [], error: null },
    });

    const container = renderPage(
      await PriceComparisonPage({ searchParams: Promise.resolve({}) }),
    );
    const emptyPanel = container.querySelector(
      '[aria-label="Scan invoices to compare prices"]',
    );
    const scannerLink = emptyPanel?.querySelector('a[href="/scan"]');

    expect(emptyPanel).not.toBeNull();
    expect(emptyPanel?.textContent).toContain(
      "Once you scan invoices from multiple distributors, price comparisons will appear here.",
    );
    expect(scannerLink?.className).toContain("h-11");
  });

  it("keeps distributor comparisons usable when retail benchmarks fail", async () => {
    authenticate({
      inventory_items: { data: [inventoryItem], error: null },
      wines: { data: null, error: new Error("retail lookup failed") },
    });

    const container = renderPage(
      await PriceComparisonPage({ searchParams: Promise.resolve({}) }),
    );
    const status = container.querySelector('[role="status"]');

    expect(status?.textContent).toContain(
      "Market benchmarks are temporarily unavailable.",
    );
    expect(container.textContent).toContain("House Producer");
    expect(container.textContent).toContain("Reserve Red");
    expect(container.textContent).toContain("Reliable Distribution");
    expect(
      container.querySelector(
        '[aria-label="Scan invoices to compare prices"]',
      ),
    ).toBeNull();
  });

  it("renders a large pricing set incrementally", async () => {
    const items = Array.from({ length: 60 }, (_, index) => ({
      ...inventoryItem,
      wine_id: `wine-${index}`,
      wines: {
        ...inventoryItem.wines,
        id: `wine-${index}`,
        name: `Reserve Red ${index}`,
      },
    }));
    authenticate({
      inventory_items: { data: items, error: null },
      wines: { data: [], error: null },
    });

    const container = renderPage(
      await PriceComparisonPage({ searchParams: Promise.resolve({}) }),
    );

    expect(
      container.querySelectorAll('[aria-label="Flag as overpaid"]'),
    ).toHaveLength(50);
    const showMore = [...container.querySelectorAll("a")].find((link) =>
      link.textContent?.includes("Show 25 more"),
    );
    expect(showMore?.getAttribute("href")).toContain("limit=50");
    expect(showMore?.className).toContain("min-h-11");
  });
});

function isHiddenFromAccessibility(element: HTMLElement) {
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current.hidden || current.getAttribute("aria-hidden") === "true") return true;
  }
  return false;
}

function getAccessibleName(element: HTMLElement) {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    return labelledBy
      .split(/\s+/)
      .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return (element.getAttribute("aria-label") ?? element.textContent ?? "")
    .replace(/\s+/g, " ")
    .trim();
}
