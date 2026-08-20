import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VALID_THEME } from "@/test/fixtures/menu-theme";

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => mocks.createClient(...args),
}));
vi.mock("@/lib/supabase/config", () => ({
  getSupabasePublicConfig: () => ({ url: "https://example.supabase.co", publishableKey: "key" }),
  isProductionRuntime: () => false,
  requireSupabasePublicConfig: () => ({ url: "https://example.supabase.co", publishableKey: "key" }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not found");
  },
}));

const { default: PublicWineListPage } = await import("./page");

const BASELINE_MAIN_CLASS =
  "mx-auto min-h-screen max-w-[720px] bg-surface px-lg py-3xl print:min-h-0 print:max-w-none print:bg-white print:px-0 print:py-0";

function lowContrastTheme() {
  return {
    ...VALID_THEME,
    palette: {
      ...VALID_THEME.palette,
      text: "#777777",
      mutedText: "#AAAAAA",
      accent: "#BBBBBB",
    },
  };
}

function clientFor(theme: unknown) {
  const list = {
    name: "Dinner",
    template: "classic",
    theme,
    restaurant_id: "restaurant-1",
    show_bin_codes: false,
    restaurants: { name: "Example", eightysix_strategy: "hide", logo_url: null },
    wine_list_sections: [],
  };
  const query = {
    eq: () => query,
    single: async () => ({ data: list, error: null }),
  };
  return { from: () => ({ select: () => query }) };
}

async function renderMain(theme: unknown): Promise<HTMLElement> {
  mocks.createClient.mockReturnValue(clientFor(theme));
  const element = await PublicWineListPage({
    params: Promise.resolve({ slug: "dinner" }),
  });
  document.body.innerHTML = renderToStaticMarkup(element);
  return document.querySelector("main")!;
}

describe("public wine-list theme render boundary", () => {
  beforeEach(() => {
    mocks.createClient.mockReset();
    document.body.innerHTML = "";
  });

  it("renders a structurally valid low-contrast stored theme as the exact unthemed baseline", async () => {
    const main = await renderMain(lowContrastTheme());

    expect(main.className).toBe(BASELINE_MAIN_CLASS);
    expect(main.getAttribute("style")).toBeNull();
  });

  it("adds theme typography and colour classes only for a renderable theme", async () => {
    const main = await renderMain(VALID_THEME);

    expect(main.className).toBe(`${BASELINE_MAIN_CLASS} font-sans text-ink`);
    expect(main.getAttribute("style")).toContain("--color-ink:#111111");
  });
});
