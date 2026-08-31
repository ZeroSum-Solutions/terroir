import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CellarFacets, CellarGroupBy, FacetCount, FacetCounts } from "@/lib/cellar-facets";
import type { CellarSort } from "@/lib/cellar-facets/sort";
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
  colour: options("Red", "White"),
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
    sort?: CellarSort | null;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    onFacetsChange?: (patch: CellarFacetPatch) => void;
    onGroupByChange?: (groupBy: CellarGroupBy | null) => void;
    onSortChange?: (sort: CellarSort | null) => void;
    onEnterSelectMode?: () => void;
  }) {
    const onFacetsChange = props.onFacetsChange ?? vi.fn();
    const onGroupByChange = props.onGroupByChange ?? vi.fn();
    const onSortChange = props.onSortChange ?? vi.fn();
    const onOpenChange = props.onOpenChange ?? vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const element = (
      <CellarFacetBar
        facets={props.facets ?? emptyFacets}
        counts={props.counts ?? diverseCounts}
        groupBy={props.groupBy ?? null}
        sort={props.sort ?? null}
        open={props.open ?? false}
        onOpenChange={onOpenChange}
        onFacetsChange={onFacetsChange}
        onGroupByChange={onGroupByChange}
        onSortChange={onSortChange}
        onEnterSelectMode={props.onEnterSelectMode}
      />
    );
    await act(async () => root.render(element));
    return {
      container,
      root,
      onFacetsChange,
      onGroupByChange,
      onSortChange,
      onOpenChange,
      render: makeRender(root),
    };
  }

  function makeRender(root: Root) {
    return async (element: ReactElement) => act(async () => root.render(element));
  }

  it("renders nothing when the sheet is closed and no filter is applied", async () => {
    const { container } = await mount({});
    expect(container.querySelector("[data-cellar-facet-bar]")).toBeNull();
  });

  it("carries Producer and Region inside the one filter surface (CELLAR-01)", async () => {
    // They used to be a standing row of their own above the list; the page is
    // allowed exactly one control row, and this is where they went.
    const { container } = await mount({ open: true });
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(labelledSelect(dialog, "Producer")).toBeDefined();
    expect(labelledSelect(dialog, "Region")).toBeDefined();
    expect(labelledSelect(dialog, "Country")).toBeDefined();
    expect(labelledSelect(dialog, "Group by")).toBeDefined();
    expect(labelledSelect(dialog, "Sort wines")).toBeDefined();
  });

  it("hides a control once it has only one selectable option", async () => {
    const { container } = await mount({
      open: true,
      counts: { ...diverseCounts, region: options("Napa") },
    });
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(labelledSelect(dialog, "Producer")).toBeDefined();
    expect(labelledSelect(dialog, "Region")).toBeUndefined();
  });

  it("ignores the disabled Unknown placeholder when counting selectable options", async () => {
    const withUnknown: FacetCount[] = [
      { value: "Napa", label: "Napa", count: 4, isUnknown: false },
      { value: "__unknown__", label: "Unknown", count: 1, isUnknown: true },
    ];
    const { container } = await mount({
      open: true,
      counts: { ...diverseCounts, region: withUnknown },
    });
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(labelledSelect(dialog, "Region")).toBeUndefined();
  });

  it("offers select-wines mode from the filter surface when the cellar has sections", async () => {
    const onEnterSelectMode = vi.fn();
    const { container } = await mount({ open: true, onEnterSelectMode });
    const dialog = container.querySelector('[role="dialog"]')!;
    await click(button(dialog, "Select wines"));
    expect(onEnterSelectMode).toHaveBeenCalled();
  });

  it("omits select-wines mode when there are no sections to assign to", async () => {
    const { container } = await mount({ open: true });
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(
      [...dialog.querySelectorAll("button")].some(
        (node) => node.textContent?.trim() === "Select wines",
      ),
    ).toBe(false);
  });

  it("applies the staged sheet selections and closes on Apply", async () => {
    const onFacetsChange = vi.fn();
    const onGroupByChange = vi.fn();
    const onSortChange = vi.fn();
    const onOpenChange = vi.fn();
    const { container } = await mount({
      open: true,
      onFacetsChange,
      onGroupByChange,
      onSortChange,
      onOpenChange,
    });

    await selectValue(labelledSelect(container, "Country")!, "France");
    await selectValue(labelledSelect(container, "Producer")!, "Alpha Estate");
    await selectValue(labelledSelect(container, "Group by")!, "varietal");
    await selectValue(labelledSelect(container, "Sort wines")!, "vintage-asc");

    await click(button(container, "Apply"));

    expect(onFacetsChange).toHaveBeenCalledWith(
      expect.objectContaining({ country: "France", producer: "Alpha Estate" }),
    );
    expect(onGroupByChange).toHaveBeenCalledWith("varietal");
    expect(onSortChange).toHaveBeenCalledWith("vintage-asc");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Reset clears every field but keeps the sheet open", async () => {
    const onFacetsChange = vi.fn();
    const onGroupByChange = vi.fn();
    const onSortChange = vi.fn();
    const { container } = await mount({
      open: true,
      facets: { ...emptyFacets, country: "France", producer: "Alpha Estate" },
      groupBy: "varietal",
      sort: "vintage-asc",
      onFacetsChange,
      onGroupByChange,
      onSortChange,
    });
    await click(button(container, "Reset"));

    expect(onFacetsChange).toHaveBeenCalledWith(
      expect.objectContaining({ producer: null, country: null, varietal: null, format: null }),
    );
    expect(onGroupByChange).toHaveBeenCalledWith(null);
    expect(onSortChange).toHaveBeenCalledWith(null);
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(labelledSelect(dialog!, "Country")!.value).toBe("");
  });

  it("closes on Escape without applying the staged draft", async () => {
    const onFacetsChange = vi.fn();
    const onOpenChange = vi.fn();
    const { container } = await mount({ open: true, onFacetsChange, onOpenChange });
    await selectValue(labelledSelect(container, "Country")!, "France");

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onFacetsChange).not.toHaveBeenCalled();
  });

  it("shows every active filter (including a deep-linked health filter and the sort) as a removable chip", async () => {
    const onFacetsChange = vi.fn();
    const onGroupByChange = vi.fn();
    const onSortChange = vi.fn();
    const { container } = await mount({
      facets: { ...emptyFacets, producer: "Alpha Estate", health: "hold" },
      groupBy: "region",
      sort: "vintage-asc",
      onFacetsChange,
      onGroupByChange,
      onSortChange,
    });

    expect(container.textContent).toContain("Producer: Alpha Estate");
    expect(container.textContent).toContain("Health: Hold");
    expect(container.textContent).toContain("Group: Region");
    expect(container.textContent).toContain("Sort: ");

    await click(chipRemoveButton(container, "Producer: Alpha Estate"));
    expect(onFacetsChange).toHaveBeenCalledWith({ producer: null });

    await click(chipRemoveButton(container, "Health: Hold"));
    expect(onFacetsChange).toHaveBeenCalledWith({ health: null });

    await click(chipRemoveButton(container, "Group: Region"));
    expect(onGroupByChange).toHaveBeenCalledWith(null);

    await click(chipRemoveButton(container, "Sort: "));
    expect(onSortChange).toHaveBeenCalledWith(null);
  });

  it("Clear all removes every facet, the group-by and the sort together", async () => {
    const onFacetsChange = vi.fn();
    const onGroupByChange = vi.fn();
    const onSortChange = vi.fn();
    const { container } = await mount({
      facets: { ...emptyFacets, producer: "Alpha Estate" },
      groupBy: "region",
      sort: "qty-desc",
      onFacetsChange,
      onGroupByChange,
      onSortChange,
    });
    await click(button(container, "Clear all"));
    expect(onFacetsChange).toHaveBeenCalledWith(
      expect.objectContaining({ producer: null, region: null, country: null }),
    );
    expect(onGroupByChange).toHaveBeenCalledWith(null);
    expect(onSortChange).toHaveBeenCalledWith(null);
  });

  it("uses the project's outline focus pattern (never outline-none + a box-shadow ring) on every facet-surface control", async () => {
    // Residuals audit — the `.glass` utility sets box-shadow as unlayered
    // CSS that always beats Tailwind's layered ring-* utilities, so any
    // focus-visible:ring-* on these controls is an automatic fail. Every
    // control here must carry the outline-based pattern instead.
    const { container } = await mount({
      open: true,
      facets: { ...emptyFacets, producer: "Alpha Estate", health: "hold" },
      groupBy: "region",
      onEnterSelectMode: vi.fn(),
    });

    expectFocusOutlinePattern(chipRemoveButton(container, "Producer: Alpha Estate"));
    expectFocusOutlinePattern(button(container, "Clear all"));

    const dialog = container.querySelector('[role="dialog"]')!;
    expectFocusOutlinePattern(labelledSelect(dialog, "Producer")!);
    expectFocusOutlinePattern(labelledSelect(dialog, "Region")!);
    expectFocusOutlinePattern(labelledSelect(dialog, "Country")!);
    expectFocusOutlinePattern(labelledSelect(dialog, "Varietal")!);
    expectFocusOutlinePattern(labelledSelect(dialog, "Group by")!);
    expectFocusOutlinePattern(labelledSelect(dialog, "Sort wines")!);
    expectFocusOutlinePattern(button(dialog, "Select wines"));
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
  // DESIGN.md — Focus: one solid token, one recipe, :focus-visible only.
  expect(classes).toContain("focus-ring");
  expect(element.className).not.toMatch(/focus(-visible)?:(ring|outline)/);
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
