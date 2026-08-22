import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AddWineModal } from "./add-wine-modal";

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousActEnvironment = reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT;
const roots: Root[] = [];

beforeAll(() => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.innerHTML = "";
  document.body.style.overflow = "";
  document.body.style.position = "";
  document.body.style.top = "";
  document.body.style.width = "";
  document.documentElement.style.overflow = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AddWineModal mobile containment", () => {
  it("locks background scrolling while open and restores the previous overflow", async () => {
    document.body.style.overflow = "scroll";
    document.documentElement.style.overflow = "auto";
    const { root } = await mount(modal());

    expect(document.body.style.overflow).toBe("hidden");
    expect(document.body.style.position).toBe("fixed");
    expect(document.body.style.width).toBe("100%");
    expect(document.documentElement.style.overflow).toBe("hidden");

    await act(async () => root.unmount());
    roots.splice(roots.indexOf(root), 1);
    expect(document.body.style.overflow).toBe("scroll");
    expect(document.body.style.position).toBe("");
    expect(document.body.style.width).toBe("");
    expect(document.documentElement.style.overflow).toBe("auto");
  });

  it("contains the sheet and its results inside the dynamic mobile viewport", async () => {
    const { container } = await mount(modal());
    const backdrop = container.querySelector<HTMLElement>("[data-add-wine-backdrop]")!;
    const panel = container.querySelector<HTMLElement>("[data-add-wine-panel]")!;
    const results = container.querySelector<HTMLElement>("[data-add-wine-results]")!;

    expect(backdrop.className).toContain("overscroll-contain");
    expect(panel.className).toContain("max-h-[100dvh]");
    expect(panel.className).toContain("overflow-hidden");
    expect(results.className).toContain("min-h-0");
    expect(results.className).toContain("overscroll-contain");
  });

  it("does not summon the keyboard on open or trigger iOS input zoom", async () => {
    const { container } = await mount(modal());
    const search = container.querySelector<HTMLInputElement>(
      'input[aria-label="Search wines"]',
    )!;

    await flushFocusFrame();
    expect(document.activeElement).not.toBe(search);
    expect(search.className).toContain("text-[16px]");
  });

  it("tracks the visual viewport when the keyboard changes the visible area", async () => {
    const viewport = fakeVisualViewport({
      height: 500,
      width: 390,
      offsetTop: 24,
      offsetLeft: 0,
    });
    vi.stubGlobal("visualViewport", viewport);
    const { container } = await mount(modal());
    const backdrop = container.querySelector<HTMLElement>("[data-add-wine-backdrop]")!;
    const panel = container.querySelector<HTMLElement>("[data-add-wine-panel]")!;

    expect(backdrop.style.height).toBe("500px");
    expect(backdrop.style.top).toBe("24px");
    expect(panel.style.maxHeight).toBe("500px");

    viewport.setGeometry({ height: 320, offsetTop: 88 });
    await act(async () => viewport.dispatchEvent(new Event("resize")));

    expect(backdrop.style.height).toBe("320px");
    expect(backdrop.style.top).toBe("88px");
    expect(panel.style.maxHeight).toBe("320px");
  });

  it("keeps every selected-wine action touch sized", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("pricing-suggestion")) {
        return jsonResponse({
          wineId: "wine-1",
          suggestedBottle: 72,
          suggestedGlass: 18,
          glassPourMl: 148,
          targetMarkupRatio: 3,
          targetPourCostPct: 25,
          retailMedian: 24,
          retailMin: 20,
          retailMax: 28,
          retailRetailerCount: 4,
          retailRefreshedAt: "2026-08-21T00:00:00.000Z",
          categoryBandApplied: false,
          hasRetailData: true,
        });
      }
      return jsonResponse([
        {
          id: "wine-1",
          name: "Reserve",
          producer: "Producer",
          vintage: 2024,
          varietal: "Pinot Noir",
          region: "Willamette Valley",
        },
      ]);
    }));
    const { container } = await mount(
      <AddWineModal
        sections={[
          { id: "section-1", name: "Sparkling" },
          { id: "section-2", name: "Rosé" },
        ]}
        activeSectionId="section-1"
        onAdd={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    const result = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("Producer, Reserve"),
    )!;
    await act(async () => result.click());
    await act(async () => Promise.resolve());

    const sectionControl = container
      .querySelector<HTMLInputElement>('input[aria-label="Add to Sparkling"]')!
      .closest("label")!;
    const useSuggestion = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Use these",
    )!;
    expect(sectionControl.className).toContain("min-h-11");
    expect(useSuggestion.className).toContain("min-h-11");
  });
});

function modal() {
  return (
    <AddWineModal
      sections={[{ id: "section-1", name: "Sparkling" }]}
      activeSectionId="section-1"
      onAdd={vi.fn()}
      onClose={vi.fn()}
    />
  );
}

async function mount(element: ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return { container, root };
}

async function flushFocusFrame() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

function fakeVisualViewport(initial: {
  height: number;
  width: number;
  offsetTop: number;
  offsetLeft: number;
}) {
  let geometry = { ...initial };
  const viewport = new EventTarget() as EventTarget & {
    readonly height: number;
    readonly width: number;
    readonly offsetTop: number;
    readonly offsetLeft: number;
    setGeometry(next: Partial<typeof geometry>): void;
  };
  Object.defineProperties(viewport, {
    height: { get: () => geometry.height },
    width: { get: () => geometry.width },
    offsetTop: { get: () => geometry.offsetTop },
    offsetLeft: { get: () => geometry.offsetLeft },
  });
  viewport.setGeometry = (next) => {
    geometry = { ...geometry, ...next };
  };
  return viewport;
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
