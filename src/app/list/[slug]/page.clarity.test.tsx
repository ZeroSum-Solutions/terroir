import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => mocks.createClient(...args),
}));
vi.mock("@/lib/supabase/config", () => ({
  getSupabasePublicConfig: () => ({
    url: "https://example.supabase.co",
    publishableKey: "key",
  }),
  isProductionRuntime: () => false,
  requireSupabasePublicConfig: () => ({
    url: "https://example.supabase.co",
    publishableKey: "key",
  }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not found");
  },
}));

const { default: PublicWineListPage } = await import("./page");

describe("public wine-list guest clarity", () => {
  beforeEach(() => {
    mocks.createClient.mockReset();
    document.body.innerHTML = "";
  });

  it("labels dual prices and availability, renders freshness and Share, and reserves logo space", async () => {
    const list = listFixture({
      restaurant: {
        name: "Example",
        eightysix_strategy: "mark",
        logo_url: "https://example.com/logo.svg",
      },
      items: [
        wineItem({
          id: "item-unavailable",
          updated_at: "2026-08-20T16:30:00.000Z",
          glass_price: 14,
          bottle_price: 58,
          is_eightysixed: true,
        }),
      ],
    });

    const { main } = await renderMain(list);

    expect(main.textContent).toContain("Glass $14");
    expect(main.textContent).toContain("Bottle $58");
    expect(main.textContent).toContain("Unavailable");
    expect(main.textContent).toContain("Updated Aug 20, 2026");
    expect(main.textContent).toContain("Share menu");

    const logo = main.querySelector<HTMLImageElement>('img[alt="Example"]')!;
    expect(logo.getAttribute("width")).toBe("200");
    expect(logo.getAttribute("height")).toBe("40");
    expect(logo.className).toContain("h-10");
    expect(logo.className).toContain("w-[200px]");
    expect(logo.className).toContain("max-w-full");

    const headerRow = [...main.querySelector("header")!.children].find(
      (element) => element.className.includes("flex-wrap"),
    ) as HTMLElement | undefined;
    expect(headerRow?.className).toContain("items-start");
    expect(headerRow?.className).toContain("justify-between");

    const shareButton = findButton(main, "Share menu");
    expect(shareButton.className).toContain("min-h-11");
    expect(shareButton.className).toContain("rounded-pill");
    expect(shareButton.className).toContain("print:hidden");
    expect(shareButton.className).toContain("focus-visible:outline-none");
    expect(shareButton.className).toContain("focus-visible:ring-2");
    expect(shareButton.className).toContain("focus-visible:ring-primary/30");
    expect(shareButton.className).toContain("focus-visible:ring-offset-2");
    expect(shareButton.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("keeps a single price explicit and preserves one published-list query", async () => {
    const list = listFixture({
      items: [
        wineItem({
          glass_price: 14,
          bottle_price: null,
        }),
      ],
    });

    const { main, single } = await renderMain(list);

    expect(main.textContent).toContain("Glass $14");
    expect(main.textContent).not.toContain("Bottle $");
    expect(single).toHaveBeenCalledTimes(1);
    expect(main.querySelector("select")).toBeNull();
  });

  it("excludes hidden and strategy-hidden items from menu freshness", async () => {
    const list = listFixture({
      updated_at: "2026-08-17T09:00:00.000Z",
      restaurant: {
        name: "Example",
        eightysix_strategy: "hide",
        logo_url: null,
      },
      items: [
        wineItem({
          id: "visible",
          position: 1,
          updated_at: "2026-08-18T09:00:00.000Z",
        }),
        wineItem({
          id: "hidden",
          position: 2,
          updated_at: "2026-08-20T09:00:00.000Z",
          hidden: true,
        }),
        wineItem({
          id: "strategy-hidden",
          position: 3,
          updated_at: "2026-08-19T09:00:00.000Z",
          is_eightysixed: true,
        }),
      ],
    });

    const { main } = await renderMain(list);

    expect(main.textContent).toContain("Updated Aug 18, 2026");
    expect(main.textContent).not.toContain("Updated Aug 19, 2026");
    expect(main.textContent).not.toContain("Updated Aug 20, 2026");
  });

  it("explains that availability can change when no wines are visible", async () => {
    const { main } = await renderMain(listFixture({ items: [] }));

    expect(main.textContent).toContain(
      "Availability changes during service; check back soon for the latest list.",
    );
  });
});

type RestaurantFixture = {
  name: string;
  eightysix_strategy: "hide" | "mark";
  logo_url: string | null;
};

type WineItemFixture = ReturnType<typeof wineItem>;

function listFixture({
  updated_at = "2026-08-18T10:00:00.000Z",
  restaurant = {
    name: "Example",
    eightysix_strategy: "hide",
    logo_url: null,
  },
  items = [wineItem()],
}: {
  updated_at?: string;
  restaurant?: RestaurantFixture;
  items?: WineItemFixture[];
} = {}) {
  return {
    name: "Dinner",
    template: "classic",
    theme: null,
    updated_at,
    restaurant_id: "restaurant-1",
    show_bin_codes: false,
    restaurants: restaurant,
    wine_list_sections: [
      {
        id: "section-1",
        name: "Reds",
        position: 1,
        wine_list_items: items,
      },
    ],
  };
}

function wineItem({
  id = "item-1",
  position = 1,
  updated_at = "2026-08-18T10:00:00.000Z",
  glass_price = 14,
  bottle_price = 58,
  hidden = false,
  is_eightysixed = false,
}: {
  id?: string;
  position?: number;
  updated_at?: string;
  glass_price?: number | null;
  bottle_price?: number | null;
  hidden?: boolean;
  is_eightysixed?: boolean;
} = {}) {
  return {
    id,
    position,
    updated_at,
    glass_price,
    bottle_price,
    tasting_note: null,
    blurb: null,
    hidden,
    name_override: null,
    wines: {
      id: `wine-${id}`,
      name: "Pinot Noir",
      producer: "Example Estate",
      vintage: 2023,
      varietal: "Pinot Noir",
      region: "Willamette Valley",
      serving_temp_min: null,
      serving_temp_max: null,
      serving_temp_label: null,
      is_eightysixed,
    },
  };
}

async function renderMain(list: ReturnType<typeof listFixture>) {
  const single = vi.fn().mockResolvedValue({ data: list, error: null });
  const query = {
    eq: vi.fn(() => query),
    single,
  };
  mocks.createClient.mockReturnValue({
    from: vi.fn(() => ({ select: vi.fn(() => query) })),
  });

  const element = await PublicWineListPage({
    params: Promise.resolve({ slug: "dinner" }),
  });
  document.body.innerHTML = renderToStaticMarkup(element);

  return { main: document.querySelector("main")!, single };
}

function findButton(container: HTMLElement, name: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!button) throw new Error(`Button not found: ${name}`);
  return button;
}
