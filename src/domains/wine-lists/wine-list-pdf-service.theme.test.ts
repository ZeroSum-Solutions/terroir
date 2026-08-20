import { beforeEach, describe, expect, it, vi } from "vitest";
import { VALID_THEME } from "@/test/fixtures/menu-theme";

const mocks = vi.hoisted(() => ({
  renderHtmlToPdf: vi.fn(),
  renderTemplate: vi.fn(),
}));

vi.mock("@/adapters/pdf", () => ({
  renderHtmlToPdf: (...args: unknown[]) => mocks.renderHtmlToPdf(...args),
}));
vi.mock("@/lib/wine-list/templates", () => ({
  renderTemplate: (...args: unknown[]) => mocks.renderTemplate(...args),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const { generateWineListPdf } = await import("./wine-list-pdf-service");

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

function supabaseFor(theme: unknown) {
  const query = {
    eq: () => query,
    single: async () => ({
      data: {
        name: "Dinner",
        template: "classic",
        theme,
        restaurant_id: "restaurant-1",
        restaurants: { name: "Example" },
        wine_list_sections: [],
      },
      error: null,
    }),
  };
  return { from: () => ({ select: () => query }) };
}

describe("PDF theme render boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.renderTemplate.mockReturnValue("<html>menu</html>");
    mocks.renderHtmlToPdf.mockResolvedValue(Buffer.from("pdf"));
  });

  it("renders a structurally valid low-contrast stored theme as unthemed", async () => {
    await generateWineListPdf({
      supabase: supabaseFor(lowContrastTheme()) as never,
      restaurantId: "restaurant-1",
      listId: "list-1",
    });

    expect(mocks.renderTemplate).toHaveBeenCalledWith(
      "classic",
      expect.objectContaining({ name: "Dinner" }),
      null,
    );
  });
});
