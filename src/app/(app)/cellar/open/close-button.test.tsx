import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const { CloseBottleButton } = await import("./close-button");

describe("CloseBottleButton mobile target", () => {
  it("keeps the close action at least 44px tall", () => {
    const html = renderToStaticMarkup(
      <CloseBottleButton bottleId="bottle-1" remainingOz={4.2} />,
    );

    expect(html).toContain("min-h-11");
  });
});
