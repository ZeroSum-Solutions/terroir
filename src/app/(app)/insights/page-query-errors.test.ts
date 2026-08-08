import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetAuthContext = vi.fn();

vi.mock("@/lib/auth-context", () => ({
  getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
}));
vi.mock("@/lib/drink-window/alerts", () => ({
  fetchDrinkWindowAlerts: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/pricing/alerts", () => ({
  fetchPricingAlerts: vi.fn().mockResolvedValue([]),
}));

const { default: InsightsPage } = await import("./page");

function makeSupabase(failedTable: string) {
  return {
    from: vi.fn((table: string) => {
      const result =
        table === failedTable
          ? { data: null, error: new Error(`${table} unavailable`) }
          : { data: [], error: null };
      const query: Record<string, unknown> & PromiseLike<typeof result> = {
        then(resolve, reject) {
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      for (const method of [
        "select",
        "eq",
        "order",
        "not",
        "lt",
        "or",
        "in",
        "gte",
        "lte",
      ]) {
        query[method] = () => query;
      }
      return query;
    }),
  };
}

function allow(failedTable: string) {
  mockGetAuthContext.mockResolvedValue({
    supabase: makeSupabase(failedTable),
    restaurantId: "restaurant-a",
    restaurantName: "Restaurant A",
    user: { email: "devszerosum@gmail.com" },
    userRole: "owner",
  });
}

describe("analytics page query errors", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not render an empty insights state when scan data is unavailable", async () => {
    allow("invoice_scans");

    await expect(
      InsightsPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow("invoice_scans unavailable");
  });
});
