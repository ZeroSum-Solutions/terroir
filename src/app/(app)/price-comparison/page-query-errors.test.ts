import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetAuthContext = vi.fn();

vi.mock("@/lib/auth-context", () => ({
  getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
}));

const { default: PriceComparisonPage } = await import("./page");

function failedInventorySupabase() {
  return {
    from: vi.fn(() => {
      const result = {
        data: null,
        error: new Error("inventory_items unavailable"),
      };
      const query: Record<string, unknown> & PromiseLike<typeof result> = {
        then(resolve, reject) {
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      for (const method of ["select", "eq", "not"]) query[method] = () => query;
      return query;
    }),
  };
}

describe("price comparison query errors", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not render an empty state when inventory is unavailable", async () => {
    mockGetAuthContext.mockResolvedValue({
      supabase: failedInventorySupabase(),
      restaurantId: "restaurant-a",
    });

    await expect(
      PriceComparisonPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow("inventory_items unavailable");
  });
});
