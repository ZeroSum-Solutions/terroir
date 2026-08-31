import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * BND-173 regression. The preview promises "This is how guests will see the
 * list", but it called renderWineListSections() with no options, so the
 * default 'hide' strategy applied to every restaurant. A restaurant whose
 * eightysix_strategy is 'mark' — whose live menu keeps 86'd wines, struck
 * through and marked Unavailable — got a preview with those wines missing
 * entirely, and no way to see what its guests actually see.
 */
const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  notFound: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mocks.requireMembership(...args),
}));

vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
  redirect: mocks.redirect,
}));

const { default: WineListPreviewPage } = await import("./page");

type SingleResult = { data: unknown; error: unknown };

function makeSupabase(result: SingleResult) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    single: () => Promise.resolve(result),
  };
  return { from: vi.fn(() => chain) };
}

function authenticate(strategy: string, items?: unknown[]) {
  mocks.requireMembership.mockResolvedValue({
    user: { id: "user-1" },
    role: "owner",
    restaurantId: "restaurant-1",
    supabase: makeSupabase({ data: listFixture(strategy, items), error: null }),
  });
}

function listFixture(strategy: string, items?: unknown[]) {
  return {
    name: "By the glass",
    is_published: true,
    slug: "by-the-glass",
    template: "classic",
    restaurant_id: "restaurant-1",
    restaurants: { name: "House", eightysix_strategy: strategy },
    wine_list_sections: [
      {
        id: "section-1",
        name: "Reds",
        position: 0,
        wine_list_items: items ?? [
          item("item-pourable", "Pourable Cuvee", false),
          item("item-eightysixed", "Sold Out Cuvee", true),
        ],
      },
    ],
  };
}

function item(
  id: string,
  name: string,
  isEightysixed: boolean,
  overrides: { producer?: string; name_override?: string | null } = {},
) {
  return {
    id,
    position: isEightysixed ? 1 : 0,
    glass_price: 18,
    bottle_price: 72,
    tasting_note: null,
    blurb: null,
    name_override: overrides.name_override ?? null,
    hidden: false,
    wines: {
      name,
      producer: overrides.producer ?? "Demo Cellars",
      vintage: 2021,
      varietal: "Nebbiolo",
      region: "Piedmont",
      serving_temp_min: null,
      serving_temp_max: null,
      serving_temp_label: null,
      is_eightysixed: isEightysixed,
      hero_image_url: null,
    },
  };
}

function renderPage(tree: ReactElement) {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(tree);
  return container;
}

async function render(strategy: string, items?: unknown[]) {
  authenticate(strategy, items);
  const tree = await WineListPreviewPage({
    params: Promise.resolve({ id: "list-1" }),
  });
  return renderPage(tree as ReactElement);
}

describe("WineListPreviewPage 86'd handling", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps 86'd wines, marked, when the restaurant's strategy is 'mark'", async () => {
    const container = await render("mark");

    expect(container.textContent).toContain("Pourable Cuvee");
    expect(container.textContent).toContain("Sold Out Cuvee");
    const marked = container.querySelector('[data-eightysixed="true"]');
    expect(marked, "the 86'd wine is not marked").not.toBeNull();
    expect(marked!.textContent).toContain("Sold Out Cuvee");
    expect(marked!.textContent).toContain("Unavailable");
    expect(marked!.className).toContain("opacity-50");
    expect(
      container.querySelectorAll('[data-eightysixed="true"]'),
    ).toHaveLength(1);
  });

  it("drops 86'd wines when the restaurant's strategy is 'hide'", async () => {
    const container = await render("hide");

    expect(container.textContent).toContain("Pourable Cuvee");
    expect(container.textContent).not.toContain("Sold Out Cuvee");
    expect(container.querySelector('[data-eightysixed="true"]')).toBeNull();
  });

  it("treats an unset strategy as 'hide', matching the public list", async () => {
    const container = await render("");

    expect(container.textContent).not.toContain("Sold Out Cuvee");
  });
});

/**
 * BUG-01. `name` still carries the producer on 98% of production's rows — a
 * CSV import put it there and migration 0137 recovered `producer` without
 * rewriting `name`. The preview composed `${producer} ${name}` itself, so it
 * printed the winery twice, and it never read `name_override`, so the one
 * label an operator had written by hand appeared on the live menu and not in
 * the preview of it. Both now go through wineListItemLabel(), the helper the
 * published menu, the print menu and the PDF already share.
 */
describe("WineListPreviewPage line labels", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows the producer once when the stored name repeats it", async () => {
    const container = await render("hide", [
      item("item-doubled", "Bruno Giacosa Barbaresco Asili", false, {
        producer: "Bruno Giacosa",
      }),
    ]);

    expect(container.textContent).toContain("Bruno Giacosa Barbaresco Asili");
    expect(container.textContent).not.toContain(
      "Bruno Giacosa Bruno Giacosa",
    );
  });

  it("leaves a stored name alone when it does not repeat the producer", async () => {
    const container = await render("hide", [
      item("item-clean", "Barbaresco Asili", false, {
        producer: "Bruno Giacosa",
      }),
    ]);

    expect(container.textContent).toContain("Bruno Giacosa Barbaresco Asili");
  });

  it("renders the operator's name_override verbatim, unrewritten", async () => {
    const container = await render("hide", [
      item("item-override", "Bruno Giacosa Barbaresco Asili", false, {
        producer: "Bruno Giacosa",
        name_override: "Bruno Giacosa — the Asili, our house pour",
      }),
    ]);

    expect(container.textContent).toContain(
      "Bruno Giacosa — the Asili, our house pour",
    );
  });
});
