import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CellarFacets, CellarGroupBy, FacetCount, FacetCounts } from "@/lib/cellar-facets";
import { CellarFacetBar, type CellarFacetPatch } from "./cellar-facet-bar";

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

function options(...labels: string[]): FacetCount[] {
  return labels.map((label) => ({
    value: label,
    label,
    count: 4,
    isUnknown: false,
  }));
}

const diverseCounts: FacetCounts = {
  producer: options("Alpha Estate", "Beta Cellars", "Canto Verde"),
  region: options("Napa", "Sonoma", "Loire"),
  country: options("USA", "France"),
  varietal: options("Cabernet Sauvignon", "Pinot Noir"),
  vintage: options("2018", "2020", "2021"),
  format: options("750", "1500"),
};

const emptyFacets: CellarFacets = {
  producer: null,
  region: null,
  country: null,
  varietal: null,
  vintageMin: null,
  vintageMax: null,
  format: null,
  health: null,
};

describe("CellarFacetBar", () => {
  const roots: Root[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
    document.body.style.overflow = "";
  });

  async function mount(props: {
    facets?: CellarFacets;
    counts?: FacetCounts;
    groupBy?: CellarGroupBy | null;
    onFacetsChange?: (patch: CellarFacetPatch) => void;
    onGroupByChange?: (groupBy: CellarGroupBy | null) => void;
  }) {
    const onFacetsChange = props.onFacetsChange ?? vi.fn();
    const onGroupByChange = props.onGroupByChange ?? vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const element = (
      <CellarFacetBar
        facets={props.facets ?? emptyFacets}
        counts={props.counts ?? diverseCounts}
        groupBy={props.groupBy ?? null}
        onFacetsChange={onFacetsChange}
        onGroupByChange={onGroupByChange}
      />
    );
    await act(async () => root.render(element));
    return { container, root, onFacetsChange, onGroupByChange, render: makeRender(root) };
  }

  function makeRender(root: Root) {
    return async (element: ReactElement) => act(async () => root.render(element));
  }

  it("renders Producer and Region in the compact row plus a Filters button", async () => {
    const { container } = await mount({});
    expect(labelledSelect(container, "Producer")).toBeDefined();
    expect(labelledSelect(container, "Region")).toBeDefined();
    expect(button(container, /^Filters/)).toBeDefined();
  });

  it("keeps Producer, Region, and Filters on one non-wrapping row (residuals audit — was 2 rows down to 320px)", async () => {
    const { container } = await mount({});
    const row = container.querySelector<HTMLElement>("[data-cellar-facet-bar] > div");
    const classes = row?.className.split(/\s+/) ?? [];
    expect(classes).toContain("flex-nowrap");
    expect(classes).not.toContain("flex-wrap");
    expect(classes).toContain("overflow-x-auto");
    // Each compact-row select is capped narrow enough on mobile that
    // Producer + Region + the Filters button fit one row at 320px.
    const producerSelect = labelledSelect(container, "Producer")!;
    expect(producerSelect.className).toContain("max-w-[88px]");
  });

  it("hides a compact-row control once it has only one selectable option", async () => {
    const { container } = await mount({
      counts: { ...diverseCounts, region: options("Napa") },
    });
    expect(labelledSelect(container, "Producer")).toBeDefined();
    expect(labelledSelect(container, "Region")).toBeUndefined();
  });

  it("ignores the disabled Unknown placeholder when counting selectable options", async () => {
    const withUnknown: FacetCount[] = [
      { value: "Napa", label: "Napa", count: 4, isUnknown: false },
      { value: "__unknown__", label: "Unknown", count: 1, isUnknown: true },
    ];
    const { container } = await mount({
      counts: { ...diverseCounts, region: withUnknown },
    });
    // Exactly one real choice ("Napa") plus an inert Unknown placeholder is
    // still not a useful control — it should be hidden.
    expect(labelledSelect(container, "Region")).toBeUndefined();
  });

  it("renders nothing when every dimension has one option and no facet is applied", async () => {
    const singleOption: FacetCounts = {
      producer: options("Only Producer"),
      region: options("Only Region"),
      country: options("Only Country"),
      varietal: options("Only Varietal"),
      vintage: options("2020"),
      format: options("750"),
    };
    const { container } = await mount({ counts: singleOption });
    expect(container.querySelector("[data-cellar-facet-bar]")).toBeNull();
  });

  it("shows a Filters badge counting active secondary facets", async () => {
    const { container } = await mount({
      facets: { ...emptyFacets, country: "France", vintageMin: 2015, vintageMax: 2020 },
      groupBy: "varietal",
    });
    const filtersButton = button(container, /^Filters/);
    // country (1) + vintage range (1, counted once) + group-by (1) = 3
    expect(filtersButton.textContent).toContain("3");
  });

  it("opens a sheet with only the secondary controls that have real choices", async () => {
    const { container } = await mount({
      counts: { ...diverseCounts, format: options("750") },
    });
    await click(button(container, /^Filters/));
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog).toBeDefined();
    expect(labelledSelect(dialog, "Country")).toBeDefined();
    expect(labelledSelect(dialog, "Varietal")).toBeDefined();
    expect(labelledSelect(dialog, "Format")).toBeUndefined();
    expect(labelledSelect(dialog, "Group by")).toBeDefined();
  });

  it("applies the staged sheet selections and closes on Apply", async () => {
    const onFacetsChange = vi.fn();
    const onGroupByChange = vi.fn();
    const { container } = await mount({ onFacetsChange, onGroupByChange });
    await click(button(container, /^Filters/));

    const countrySelect = labelledSelect(container, "Country")!;
    await selectValue(countrySelect, "France");
    const groupBySelect = labelledSelect(container, "Group by")!;
    await selectValue(groupBySelect, "varietal");

    await click(button(container, "Apply"));

    expect(onFacetsChange).toHaveBeenCalledWith(
      expect.objectContaining({ country: "France" }),
    );
    expect(onGroupByChange).toHaveBeenCalledWith("varietal");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("Reset clears every field (including compact-row facets) but keeps the sheet open", async () => {
    const onFacetsChange = vi.fn();
    const onGroupByChange = vi.fn();
    const { container } = await mount({
      facets: { ...emptyFacets, country: "France", producer: "Alpha Estate" },
      groupBy: "varietal",
      onFacetsChange,
      onGroupByChange,
    });
    await click(button(container, /^Filters/));
    await click(button(container, "Reset"));

    expect(onFacetsChange).toHaveBeenCalledWith(
      expect.objectContaining({ producer: null, country: null, varietal: null, format: null }),
    );
    expect(onGroupByChange).toHaveBeenCalledWith(null);
    // The sheet itself stays open with its own fields visibly cleared.
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(labelledSelect(dialog!, "Country")!.value).toBe("");
  });

  it("closes on Escape without applying the staged draft", async () => {
    const onFacetsChange = vi.fn();
    const { container } = await mount({ onFacetsChange });
    await click(button(container, /^Filters/));
    const countrySelect = labelledSelect(container, "Country")!;
    await selectValue(countrySelect, "France");

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(onFacetsChange).not.toHaveBeenCalled();
  });

  it("shows every active filter (including a deep-linked health filter) as a removable chip", async () => {
    const onFacetsChange = vi.fn();
    const onGroupByChange = vi.fn();
    const { container } = await mount({
      facets: { ...emptyFacets, producer: "Alpha Estate", health: "hold" },
      groupBy: "region",
      onFacetsChange,
      onGroupByChange,
    });

    expect(container.textContent).toContain("Producer: Alpha Estate");
    expect(container.textContent).toContain("Health: Hold");
    expect(container.textContent).toContain("Group: Region");

    await click(chipRemoveButton(container, "Producer: Alpha Estate"));
    expect(onFacetsChange).toHaveBeenCalledWith({ producer: null });

    await click(chipRemoveButton(container, "Health: Hold"));
    expect(onFacetsChange).toHaveBeenCalledWith({ health: null });

    await click(chipRemoveButton(container, "Group: Region"));
    expect(onGroupByChange).toHaveBeenCalledWith(null);
  });

  it("Clear all removes every facet and the group-by together", async () => {
    const onFacetsChange = vi.fn();
    const onGroupByChange = vi.fn();
    const { container } = await mount({
      facets: { ...emptyFacets, producer: "Alpha Estate" },
      groupBy: "region",
      onFacetsChange,
      onGroupByChange,
    });
    await click(button(container, "Clear all"));
    expect(onFacetsChange).toHaveBeenCalledWith(
      expect.objectContaining({ producer: null, region: null, country: null }),
    );
    expect(onGroupByChange).toHaveBeenCalledWith(null);
  });

  it("uses the project's outline focus pattern (never outline-none + a box-shadow ring) on every facet-surface control", async () => {
    // Residuals audit — the `.glass` utility sets box-shadow as unlayered
    // CSS that always beats Tailwind's layered ring-* utilities, so any
    // focus-visible:ring-* on these controls is an automatic fail. Every
    // control here must carry the outline-based pattern instead.
    const onFacetsChange = vi.fn();
    const onGroupByChange = vi.fn();
    const { container } = await mount({
      facets: { ...emptyFacets, producer: "Alpha Estate", health: "hold" },
      groupBy: "region",
      onFacetsChange,
      onGroupByChange,
    });

    expectFocusOutlinePattern(labelledSelect(container, "Producer")!);
    expectFocusOutlinePattern(labelledSelect(container, "Region")!);
    expectFocusOutlinePattern(button(container, /^Filters/));
    expectFocusOutlinePattern(chipRemoveButton(container, "Producer: Alpha Estate"));
    expectFocusOutlinePattern(button(container, "Clear all"));

    await click(button(container, /^Filters/));
    const dialog = container.querySelector('[role="dialog"]')!;
    expectFocusOutlinePattern(labelledSelect(dialog, "Country")!);
    expectFocusOutlinePattern(labelledSelect(dialog, "Varietal")!);
    expectFocusOutlinePattern(labelledSelect(dialog, "Group by")!);
    expectFocusOutlinePattern(
      dialog.querySelector<HTMLButtonElement>('button[aria-label="Close filters"]')!,
    );
    expectFocusOutlinePattern(button(dialog, "Reset"));
    expectFocusOutlinePattern(button(dialog, "Apply"));
  });
});

function labelledSelect(root: ParentNode, label: string) {
  return root.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`) ?? undefined;
}

function button(root: ParentNode, name: string | RegExp) {
  return [...root.querySelectorAll<HTMLButtonElement>("button")].find((node) => {
    const text = node.textContent?.trim() ?? "";
    return typeof name === "string" ? text === name : name.test(text);
  })!;
}

function chipRemoveButton(root: ParentNode, chipLabel: string) {
  const chip = [...root.querySelectorAll<HTMLElement>("span")].find((node) =>
    node.textContent?.startsWith(chipLabel),
  )!;
  return chip.querySelector<HTMLButtonElement>("button")!;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

function expectFocusOutlinePattern(element: HTMLElement) {
  const classes = element.className.split(/\s+/);
  expect(classes).toContain("focus-visible:outline");
  expect(classes).toContain("focus-visible:outline-2");
  expect(classes).toContain("focus-visible:outline-offset-2");
  expect(classes).toContain("focus-visible:outline-accent");
  // The banned pattern this replaces: `.glass`'s unlayered CSS beats a
  // layered Tailwind ring, so outline-none + a ring is an automatic fail.
  expect(classes).not.toContain("outline-none");
  expect(classes.some((c) => c.startsWith("focus-visible:ring"))).toBe(false);
}

async function selectValue(select: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(
      select,
      value,
    );
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
