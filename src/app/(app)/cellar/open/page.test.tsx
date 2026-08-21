import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
}));

vi.mock("@/lib/auth-context", () => ({
  getAuthContext: (...args: unknown[]) => mocks.getAuthContext(...args),
}));

const { default: OpenBottlesPage } = await import("./page");

type QueryResult = { data: unknown[] | null; error: unknown };

function authenticate(result: QueryResult) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    is: () => chain,
    order: () => chain,
    then: (
      resolve: (value: QueryResult) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject),
  };

  mocks.getAuthContext.mockResolvedValue({
    user: { id: "user-1" },
    userRole: "owner",
    restaurantId: "restaurant-1",
    restaurantName: "House",
    supabase: { from: vi.fn(() => chain) },
  });
}

describe("OpenBottlesPage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws an open_bottles query failure instead of presenting it as no bottles", async () => {
    const error = new Error("forced query failure");
    authenticate({ data: null, error });

    await expect(OpenBottlesPage()).rejects.toBe(error);
  });

  it("renders the genuine no-open-bottle outcome with a reachable cellar action", async () => {
    authenticate({ data: [], error: null });

    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(await OpenBottlesPage());
    const emptyPanel = container.querySelector(
      '[aria-label="No open bottles"]',
    );
    const cellarLink = emptyPanel?.querySelector('a[href="/cellar"]');

    expect(emptyPanel).not.toBeNull();
    expect(emptyPanel?.textContent).toContain(
      "Open a bottle from the cellar to start tracking pours.",
    );
    expect(cellarLink?.className).toContain("h-11");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
