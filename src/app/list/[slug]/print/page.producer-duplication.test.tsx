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

const { default: PrintWineListPage } = await import("./page");

/**
 * BUG-01 on paper. The printed menu composed the same `${producer} ${name}`
 * line as the on-screen one, so a restaurant that printed its list printed the
 * winery twice on 98% of its rows — and a printed mistake cannot be patched by
 * a redeploy.
 */
describe("printed wine list — the producer, shown once", () => {
  beforeEach(() => {
    mocks.createClient.mockReset();
  });

  it("does not repeat a producer that is already inside the wine name", async () => {
    const html = await render([
      wineItem({
        id: "esporao",
        producer: "Esporão",
        name: "Esporão Reserva Tinto",
      }),
    ]);

    expect(html).toContain("Esporão Reserva Tinto");
    expect(html).not.toContain("Esporão Esporão");
  });

  it("keeps a name that merely opens with the producer's letters intact", async () => {
    const html = await render([
      wineItem({
        id: "oberrotweil",
        producer: "Oberrotweil",
        name: "Oberrotweiler Spätburgunder Spätlese Trocken",
      }),
    ]);

    expect(html).toContain(
      "Oberrotweil Oberrotweiler Spätburgunder Spätlese Trocken",
    );
  });

  it("never rewrites a name_override — those are the owner's own words", async () => {
    const html = await render([
      wineItem({
        id: "override",
        producer: "Esporão",
        name: "Esporão Reserva Tinto",
        name_override: "Esporão Esporão, house pour",
      }),
    ]);

    expect(html).toContain("Esporão Esporão, house pour");
  });
});

function wineItem({
  id,
  producer,
  name,
  name_override = null,
}: {
  id: string;
  producer: string;
  name: string;
  name_override?: string | null;
}) {
  return {
    id,
    position: 1,
    glass_price: 14,
    bottle_price: 58,
    tasting_note: null,
    blurb: null,
    hidden: false,
    name_override,
    wines: {
      name,
      producer,
      vintage: 2021,
      varietal: null,
      region: null,
      serving_temp_min: null,
      serving_temp_max: null,
      serving_temp_label: null,
      is_eightysixed: false,
    },
  };
}

async function render(items: ReturnType<typeof wineItem>[]) {
  const list = {
    name: "Dinner",
    template: "classic",
    restaurant_id: "restaurant-1",
    restaurants: { name: "Example", eightysix_strategy: "hide" },
    wine_list_sections: [
      { id: "section-1", name: "Reds", position: 1, wine_list_items: items },
    ],
  };
  const query = {
    eq: vi.fn(() => query),
    single: vi.fn().mockResolvedValue({ data: list, error: null }),
  };
  mocks.createClient.mockReturnValue({
    from: vi.fn(() => ({ select: vi.fn(() => query) })),
  });

  const element = await PrintWineListPage({
    params: Promise.resolve({ slug: "dinner" }),
  });
  return renderToStaticMarkup(element);
}
