/**
 * LIST-03 (the suggestion is the starting price) and LIST-06 cause B (the
 * modal must name the section the wine will actually land in).
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AddWineModal } from "./add-wine-modal";

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousActEnvironment = reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT;
const roots: Root[] = [];

const SECTIONS = [
  { id: "section-sparkling", name: "Sparkling" },
  { id: "section-red", name: "Red" },
];

const RED_WINE = {
  id: "wine-red",
  name: "Vosne-Romanée",
  producer: "Benjamin Leroux",
  vintage: 2019,
  varietal: "Pinot Noir",
  region: "Burgundy",
  colour: "red",
  hero_image_url: null,
};

const SUGGESTION = {
  wineId: "wine-red",
  suggestedBottle: 175,
  suggestedGlass: 22,
  glassPourMl: 148,
  targetMarkupRatio: 2.7,
  targetPourCostPct: 22,
  retailMedian: 65,
  retailMin: 60,
  retailMax: 80,
  retailRetailerCount: 6,
  retailRefreshedAt: "2026-08-21T00:00:00.000Z",
  categoryBandApplied: false,
  hasRetailData: true,
};

beforeAll(() => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  document.body.style.overflow = "";
  document.body.style.position = "";
  document.body.style.top = "";
  document.body.style.width = "";
  document.documentElement.style.overflow = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubApi(suggestion: unknown = SUGGESTION) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("pricing-suggestion")
        ? json(suggestion)
        : json([RED_WINE]),
    ),
  );
}

async function selectTheRed(onAdd = vi.fn()) {
  const { container } = await mount(
    <AddWineModal
      sections={SECTIONS}
      activeSectionId="section-sparkling"
      onAdd={onAdd}
      onClose={vi.fn()}
    />,
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
  const result = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.includes("Benjamin Leroux, Vosne-Romanée"),
  )!;
  await act(async () => result.click());
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return { container, onAdd };
}

describe("AddWineModal pricing and destination", () => {
  it("names the section the wine will land in, not the one on screen", async () => {
    stubApi();
    const { container } = await selectTheRed();

    // The user was viewing Sparkling; a red is filed under Red.
    expect(container.querySelector("#add-wine-title")!.textContent).toBe(
      "Add wine to Red",
    );
    const submit = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.startsWith("Add to"),
    )!;
    expect(submit.textContent).toBe("Add to Red");
  });

  it("names both sections when the user picks a second one", async () => {
    stubApi();
    const { container } = await selectTheRed();

    const sparkling = container.querySelector<HTMLInputElement>(
      'input[aria-label="Add to Sparkling"]',
    )!;
    await act(async () => sparkling.click());

    // Listed in the list's own section order, not in the order they were ticked.
    expect(container.querySelector("#add-wine-title")!.textContent).toBe(
      "Add wine to Sparkling and Red",
    );
  });

  it("fills both price inputs with the suggestion, unprompted", async () => {
    stubApi();
    const { container } = await selectTheRed();

    expect(
      container.querySelector<HTMLInputElement>("#add-wine-glass-price")!.value,
    ).toBe("22");
    expect(
      container.querySelector<HTMLInputElement>("#add-wine-bottle-price")!.value,
    ).toBe("175");
  });

  it("leaves the inputs empty when no suggestion can be computed", async () => {
    stubApi({ ...SUGGESTION, suggestedBottle: null, suggestedGlass: null, hasRetailData: false });
    const { container } = await selectTheRed();

    expect(
      container.querySelector<HTMLInputElement>("#add-wine-bottle-price")!.value,
    ).toBe("");
    expect(container.textContent).toContain("Pricing data unavailable");
  });

  it("hands the editor the whole wine and the suggestion behind the prices", async () => {
    stubApi();
    const onAdd = vi.fn();
    const { container } = await selectTheRed(onAdd);

    const submit = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.startsWith("Add to"),
    )!;
    await act(async () => submit.click());

    expect(onAdd).toHaveBeenCalledWith({
      wine: expect.objectContaining({ id: "wine-red", colour: "red" }),
      glassPrice: 22,
      bottlePrice: 175,
      suggestedGlassPrice: 22,
      suggestedBottlePrice: 175,
      sectionIds: ["section-red"],
    });
  });
});

async function mount(element: ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return { container, root };
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
