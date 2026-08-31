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
    // LIST-05 — the picker used to hide every non-PNG, which is most logos.
    expect(input.accept.split(",")).toEqual(
      expect.arrayContaining(["image/png", "image/jpeg", "image/webp"]),
    );
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

  it("keeps logo and theme actions at least 44px tall", async () => {
    const { root, container } = await renderPanel(STORED_PROPOSALS);
    const upload = container.querySelector<HTMLInputElement>(
      'input[aria-label="Upload logo"]',
    )!;
    const generate = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Generate themes"),
    )!;

    expect(upload.closest("label")?.className).toContain("min-h-11");
    expect(generate.className).toContain("min-h-11");
    await act(async () => root.unmount());
  });

  it("offers a website address as a second way in (LIST-05)", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      brandKit: {
        logoUrl: null,
        palette: { colors: ["#2244CC"] },
        proposals: null,
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { root, container } = await renderPanel(STORED_PROPOSALS);

    const url = container.querySelector<HTMLInputElement>(
      'input[aria-label="Business website"]',
    )!;
    expect(url).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
        .call(url, "thefrenchlaundry.com");
      url.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      url.closest("form")!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/brand-kit",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ url: "thefrenchlaundry.com" }),
      }),
    );
    expect(container.querySelector("[data-palette-swatch]")).not.toBeNull();
    await act(async () => root.unmount());
  });

  it("takes an image dropped onto the panel", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      brandKit: {
        logoUrl: "data:image/jpeg;base64,aaa",
        palette: { colors: ["#123456"] },
        proposals: null,
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { root, container } = await renderPanel(STORED_PROPOSALS);

    const panel = container.querySelector<HTMLElement>('section[aria-label="Brand kit"]')!;
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: {
        files: [new File(["jpg"], "logo.jpg", { type: "image/jpeg" })],
        getData: () => "",
      },
    });
    await act(async () => {
      panel.dispatchEvent(drop);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/brand-kit",
      expect.objectContaining({ method: "POST", body: expect.any(FormData) }),
    );
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