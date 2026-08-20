import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VALID_THEME } from "@/test/fixtures/menu-theme";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

const { BrandKitPanel } = await import("./brand-kit-panel");

const STORED_PROPOSALS = [
  VALID_THEME,
  { ...VALID_THEME, name: "Paper Reserve" },
  { ...VALID_THEME, name: "Night Service" },
];

describe("BrandKitPanel proposal identity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("clears stale client proposals when a new logo response contains none", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      brandKit: {
        logoUrl: "data:image/png;base64,bmV3",
        palette: { colors: ["#CC2233"] },
        proposals: null,
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    const { root, container } = await renderPanel(STORED_PROPOSALS);
    expect(container.querySelectorAll("article")).toHaveLength(3);

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.accept).toBe("image/png");
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new File(["png"], "new-logo.png", { type: "image/png" })],
    });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelectorAll("article")).toHaveLength(0);
    await act(async () => root.unmount());
  });

  it("does not use duplicate theme names as React list keys", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const duplicateNames = [
      VALID_THEME,
      { ...VALID_THEME },
      { ...VALID_THEME, name: "Night Service" },
    ];
    const { root } = await renderPanel(duplicateNames);

    expect(
      consoleError.mock.calls.some((call) => call.some((value) =>
        String(value).includes("same key"),
      )),
    ).toBe(false);
    await act(async () => root.unmount());
  });
});

async function renderPanel(proposals: typeof STORED_PROPOSALS) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <BrandKitPanel
        listId="11111111-1111-4111-8111-111111111111"
        initialBrandKit={{
          logoUrl: "data:image/png;base64,b2xk",
          palette: { colors: ["#721D35"] },
          proposals,
        }}
        initialTheme={null}
      />,
    );
  });
  return { root, container };
}
