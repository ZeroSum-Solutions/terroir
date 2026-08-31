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

/**
 * BUG-01 — the guest menu is the surface a customer reads, and it composed its
 * line as `${producer} ${name}`. 391 of 400 production rows carry the producer
 * inside `name` as well, so 98% of a published menu named the winery twice.
 *
 * The shapes here are the ones this checkout actually holds, not invented ones:
 * `Esporão` / `Esporão Reserva Tinto` is the plain duplication, and
 * `Oberrotweil` / `Oberrotweiler Spätburgunder Spätlese Trocken` is the trap a
 * character-wise `startsWith` strip would render as "er Spätburgunder…".
 */
describe("public wine list — the producer, shown once", () => {
  beforeEach(() => {
    mocks.createClient.mockReset();
    document.body.innerHTML = "";
  });

  it("does not repeat a producer that is already inside the wine name", async () => {
    const { main } = await renderMain(
      listFixture({
        items: [
          wineItem({
            id: "esporao",
            producer: "Esporão",
            name: "Esporão Reserva Tinto",
          }),
        ],
      }),
    );

    expect(main.textContent).toContain("Esporão Reserva Tinto");
    expect(main.textContent).not.toContain("Esporão Esporão");
  });

  it("keeps a name that merely opens with the producer's letters intact", async () => {
    const { main } = await renderMain(
      listFixture({
        items: [
          wineItem({
            id: "oberrotweil",
            producer: "Oberrotweil",
            name: "Oberrotweiler Spätburgunder Spätlese Trocken",
          }),
        ],
      }),
    );

    // A startsWith strip renders "Oberrotweil er Spätburgunder…" here.
    expect(main.textContent).toContain(
      "Oberrotweil Oberrotweiler Spätburgunder Spätlese Trocken",
    );
    expect(main.textContent).not.toContain("er Spätburgunder Spätlese Trocken,");
  });

  it("leaves a wine whose producer is not in its name alone", async () => {
    const { main } = await renderMain(
      listFixture({
        items: [
          wineItem({
            id: "clean",
            producer: "Example Estate",
            name: "Pinot Noir",
          }),
        ],
      }),
    );

    expect(main.textContent).toContain("Example Estate Pinot Noir");
  });

  it("never rewrites a name_override — those are the owner's own words", async () => {
    const { main } = await renderMain(
      listFixture({
        items: [
          wineItem({
            id: "override",
            producer: "Esporão",
            name: "Esporão Reserva Tinto",
            name_override: "Esporão Esporão, house pour",
          }),
        ],
      }),
    );

    expect(main.textContent).toContain("Esporão Esporão, house pour");
  });
});

function listFixture({ items }: { items: ReturnType<typeof wineItem>[] }) {
  return {
    name: "Dinner",
    template: "classic",
    theme: null,
    updated_at: "2026-08-18T10:00:00.000Z",
    restaurant_id: "restaurant-1",
    show_bin_codes: false,
    restaurants: {
      name: "Example",
      eightysix_strategy: "hide",
      logo_url: null,
    },
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
    updated_at: "2026-08-18T10:00:00.000Z",
    glass_price: 14,
    bottle_price: 58,
    tasting_note: null,
    blurb: null,
    hidden: false,
    name_override,
    wines: {
      id: `wine-${id}`,
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

  return { main: document.querySelector("main")! };
}
