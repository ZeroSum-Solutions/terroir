import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const { OverpaidFlagButton } = await import("./overpaid-flag-button");

describe("OverpaidFlagButton touch target", () => {
  it("is at least 44px square", () => {
    const html = renderToStaticMarkup(
      <OverpaidFlagButton wineId="wine-1" flagged={false} />,
    );

    expect(html).toContain("min-h-11");
    expect(html).toContain("min-w-11");
  });
});
