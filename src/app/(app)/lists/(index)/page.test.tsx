import type { ReactElement } from "react";
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

const { default: WineListPage } = await import("./page");

type QueryResult = { data: unknown[] | null; error: unknown };

function makeSupabase(result: QueryResult) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    then: (
      resolve: (value: QueryResult) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject),
  };

  return { from: vi.fn(() => chain) };
}

function authenticate(result: QueryResult) {
  mocks.getAuthContext.mockResolvedValue({
    user: { id: "user-1" },
    userRole: "owner",
    restaurantId: "restaurant-1",
    restaurantName: "House",
    supabase: makeSupabase(result),
  });
}

function renderPage(tree: ReactElement) {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(tree);
  return container;
}

describe("WineListPage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws a wine_lists query failure instead of presenting it as no lists", async () => {
    const error = new Error("forced query failure");
    authenticate({ data: null, error });

    await expect(
      WineListPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toBe(error);
  });

  it("renders the genuine no-list outcome with an accessible create action", async () => {
    authenticate({ data: [], error: null });

    const tree = await WineListPage({ searchParams: Promise.resolve({}) });
    const container = renderPage(tree);
    const emptyPanel = container.querySelector(
      '[aria-label="Create your first wine list"]',
    );
    const createButton = [...(emptyPanel?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.trim() === "New wine list",
    );

    expect(emptyPanel).not.toBeNull();
    expect(container.textContent).toContain("Create your first wine list");
    expect(createButton?.className).toContain("h-11");
  });

  it("keeps an archived-only result recoverable instead of replacing it with generic emptiness", async () => {
    authenticate({
      data: [
        {
          id: "list-archived",
          name: "Cellar Archive",
          description: null,
          archived: true,
          is_published: false,
          slug: null,
          last_published_at: null,
          updated_at: "2026-08-20T18:00:00.000Z",
          wine_list_sections: [],
        },
      ],
      error: null,
    });

    const tree = await WineListPage({ searchParams: Promise.resolve({}) });
    const props = tree.props as {
      lists: unknown[];
      archivedLists: Array<{ id: string }>;
    };
    const container = renderPage(tree);
    const recoveryLink = container.querySelector(
      'a[href="/lists?show_archived=1"]',
    );

    expect(props.lists).toEqual([]);
    expect(props.archivedLists.map((list) => list.id)).toEqual([
      "list-archived",
    ]);
    expect(container.textContent).toContain("All wine lists are archived");
    expect(container.textContent).not.toContain("Create your first wine list");
    expect(recoveryLink?.className).toContain("h-11");
  });
});
