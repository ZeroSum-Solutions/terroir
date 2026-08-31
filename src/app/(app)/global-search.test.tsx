import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: vi.fn() }),
}));

const { GlobalSearch } = await import("./global-search");

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousActEnvironment = reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT;

beforeAll(() => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

const WINE = {
  id: "wine-1",
  name: "Monte Bello",
  producer: "Ridge",
  vintage: 2016,
  varietal: "Cabernet Sauvignon",
  region: "Santa Cruz Mountains",
  colour: "red",
  hero_image_url: null,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function render() {
  act(() => {
    root.render(<GlobalSearch />);
  });
  return container.querySelector<HTMLInputElement>('input[type="search"]')!;
}

function type(input: HTMLInputElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Runs the debounce timer and lets the fetch promise chain settle. */
async function settle() {
  await act(async () => {
    vi.advanceTimersByTime(300);
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe("GlobalSearch", () => {
  it("is a visible search field, not a trigger that hides one", () => {
    const input = render();
    expect(input).not.toBeNull();
    expect(input.getAttribute("placeholder")).toBe("Search all wines…");
    expect(input.dataset.globalSearch).toBe("true");
    expect(container.querySelector('form[role="search"]')).not.toBeNull();
  });

  it("does not query on a single character", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const input = render();
    type(input, "r");
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("queries /api/wines/search once the query is long enough", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [WINE],
    });
    vi.stubGlobal("fetch", fetchMock);

    const input = render();
    type(input, "ridge");
    await settle();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/wines/search?q=ridge",
      expect.objectContaining({ signal: expect.anything() }),
    );
    const panel = document.querySelector("[data-global-search-panel]")!;
    expect(panel.textContent).toContain("Ridge");
    expect(panel.textContent).toContain("Monte Bello");
  });

  it("opens the wine it is given rather than guessing a route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => [WINE] }),
    );
    const input = render();
    type(input, "ridge");
    await settle();

    const option = document
      .querySelector("[data-global-search-panel]")!
      .querySelector("button")!;
    act(() => {
      option.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mocks.push).toHaveBeenCalledWith("/cellar/wine-1");
  });

  it("says so plainly when nothing matches, and still offers the full search", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => [] }),
    );
    const input = render();
    type(input, "zzzz");
    await settle();

    const panel = document.querySelector("[data-global-search-panel]")!;
    expect(panel.textContent).toContain("No wine in your cellar matches that.");
    expect(panel.textContent).toContain("See all matches in the cellar");
  });

  it("hands a failed request the same empty state instead of a broken panel", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const input = render();
    type(input, "ridge");
    await settle();

    expect(
      document.querySelector("[data-global-search-panel]")!.textContent,
    ).toContain("No wine in your cellar matches that.");
  });
});
