import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetAuthContext = vi.fn();

vi.mock("@/lib/auth-context", () => ({
  getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
}));
vi.mock("./sort-controls", () => ({
  SortControls: () => <span>Variance sort control</span>,
}));
vi.mock("./export-csv-button", () => ({ ExportCsvButton: () => null }));
vi.mock("@/components/overpaid-flag-button", () => ({
  OverpaidFlagButton: () => null,
}));

const { default: PriceComparisonPage } = await import("./page");

function queryResult(data: unknown[]) {
  const result = { data, error: null };
  const query: Record<string, unknown> & PromiseLike<typeof result> = {
    then(resolve, reject) {
      return Promise.resolve(result).then(resolve, reject);
    },
  };
  for (const method of ["select", "eq", "not"]) query[method] = () => query;
  return query;
}

describe("price comparison market shift", () => {
  beforeEach(() => vi.clearAllMocks());

  it("labels a market-to-market move without confusing purchase variance", async () => {
    const wine = {
      id: "wine-a",
      name: "Estate Cabernet",
      producer: "Example Estate",
      vintage: 2020,
      varietal: "Cabernet",
      retail_median: 120,
      retail_previous_median: 100,
      retail_previous_refreshed_at: "2026-01-01T00:00:00.000Z",
      retail_min: 110,
      retail_max: 130,
      enrichment_metadata: null,
      overpaid_flag: false,
    };
    mockGetAuthContext.mockResolvedValue({
      restaurantId: "restaurant-a",
      supabase: {
        from: vi.fn((table: string) =>
          table === "inventory_items"
            ? queryResult([
                {
                  unit_cost: 80,
                  quantity: 1,
                  wine_id: wine.id,
                  wines: wine,
                  invoice_scan_id: "scan-a",
                  invoice_scans: {
                    distributor_name: "Distributor A",
                    invoice_date: "2026-02-01",
                  },
                },
                {
                  unit_cost: 90,
                  quantity: 1,
                  wine_id: wine.id,
                  wines: wine,
                  invoice_scan_id: "scan-b",
                  invoice_scans: {
                    distributor_name: "Distributor B",
                    invoice_date: "2026-02-02",
                  },
                },
              ])
            : queryResult([wine]),
        ),
      },
    });

    const element = await PriceComparisonPage({
      searchParams: Promise.resolve({}),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Market shift");
    expect(html).toContain("Market rose 20%");
    expect(html).not.toContain("Market rose 50%");
  });

  it("sorts comparable and single-source rows by variance", async () => {
    const makeWine = (id: string, producer: string) => ({
      id,
      name: `${producer} Wine`,
      producer,
      vintage: 2020,
      varietal: "Cabernet",
      retail_median: 100,
      retail_previous_median: null,
      retail_previous_refreshed_at: null,
      retail_min: 90,
      retail_max: 110,
      enrichment_metadata: null,
      overpaid_flag: false,
    });
    const comparableHigh = makeWine("comp-high", "Zulu Comparable");
    const comparableLow = makeWine("comp-low", "Alpha Comparable");
    const singleHigh = makeWine("single-high", "Yankee Single");
    const singleLow = makeWine("single-low", "Bravo Single");
    const inventoryRow = (
      wine: ReturnType<typeof makeWine>,
      unitCost: number,
      distributor: string,
    ) => ({
      unit_cost: unitCost,
      quantity: 1,
      wine_id: wine.id,
      wines: wine,
      invoice_scan_id: `${wine.id}-${distributor}`,
      invoice_scans: {
        distributor_name: distributor,
        invoice_date: "2026-02-01",
      },
    });
    const wines = [comparableHigh, comparableLow, singleHigh, singleLow];
    mockGetAuthContext.mockResolvedValue({
      restaurantId: "restaurant-a",
      supabase: {
        from: vi.fn((table: string) =>
          table === "inventory_items"
            ? queryResult([
                inventoryRow(comparableHigh, 150, "Distributor A"),
                inventoryRow(comparableHigh, 150, "Distributor B"),
                inventoryRow(comparableLow, 50, "Distributor A"),
                inventoryRow(comparableLow, 50, "Distributor B"),
                inventoryRow(singleHigh, 140, "Distributor A"),
                inventoryRow(singleLow, 60, "Distributor A"),
              ])
            : queryResult(wines),
        ),
      },
    });

    const element = await PriceComparisonPage({
      searchParams: Promise.resolve({ sort: "variance", ord: "desc" }),
    });
    const html = renderToStaticMarkup(element);

    expect(html.indexOf("Zulu Comparable")).toBeLessThan(
      html.indexOf("Alpha Comparable"),
    );
    expect(html.indexOf("Yankee Single")).toBeLessThan(
      html.indexOf("Bravo Single"),
    );
    expect(html).toContain("Variance sort control");
  });

  it("offers variance sorting when every wine has one source", async () => {
    const wine = {
      id: "single-only",
      name: "Solo Wine",
      producer: "Solo Producer",
      vintage: 2020,
      varietal: "Cabernet",
      retail_median: 100,
      retail_previous_median: null,
      retail_previous_refreshed_at: null,
      retail_min: 90,
      retail_max: 110,
      enrichment_metadata: null,
      overpaid_flag: false,
    };
    mockGetAuthContext.mockResolvedValue({
      restaurantId: "restaurant-a",
      supabase: {
        from: vi.fn((table: string) =>
          table === "inventory_items"
            ? queryResult([
                {
                  unit_cost: 120,
                  quantity: 1,
                  wine_id: wine.id,
                  wines: wine,
                  invoice_scan_id: "scan-a",
                  invoice_scans: {
                    distributor_name: "Distributor A",
                    invoice_date: "2026-02-01",
                  },
                },
              ])
            : queryResult([wine]),
        ),
      },
    });

    const element = await PriceComparisonPage({
      searchParams: Promise.resolve({}),
    });

    expect(renderToStaticMarkup(element)).toContain("Variance sort control");
  });
});
