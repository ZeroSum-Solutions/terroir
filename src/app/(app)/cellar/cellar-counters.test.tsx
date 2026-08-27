import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildCellarCounters,
  CellarCounters,
  type CellarCounterAlerts,
} from "./cellar-counters";

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

const baseAlerts: CellarCounterAlerts = {
  totalBottles: 1364,
  openCount: 36,
  outCount: 6,
  lowCount: 0,
  drinkNowCount: 0,
  holdCount: 0,
};

describe("buildCellarCounters", () => {
  it("always includes All, formats the bottle total, and keeps non-zero counters", () => {
    const counters = buildCellarCounters(baseAlerts);
    expect(counters.map((c) => c.id)).toEqual(["all", "open", "out"]);
    expect(counters[0]).toEqual({ id: "all", label: "All", value: "1,364" });
    expect(counters[1]).toEqual({ id: "open", label: "Open", value: 36 });
  });

  it("suppresses every zero-count counter — a filter to nothing is noise", () => {
    const counters = buildCellarCounters({
      ...baseAlerts,
      openCount: 0,
      outCount: 0,
    });
    expect(counters.map((c) => c.id)).toEqual(["all"]);
  });

  it("only adds Drink now / Hold when their counts are positive", () => {
    const withNeither = buildCellarCounters(baseAlerts);
    expect(withNeither.some((c) => c.id === "drink-now")).toBe(false);
    expect(withNeither.some((c) => c.id === "hold")).toBe(false);

    const withBoth = buildCellarCounters({
      ...baseAlerts,
      lowCount: 2,
      drinkNowCount: 147,
      holdCount: 3,
    });
    expect(withBoth.map((c) => c.id)).toEqual(["all", "open", "out", "low", "drink-now", "hold"]);
    expect(withBoth.find((c) => c.id === "drink-now")).toEqual({
      id: "drink-now",
      label: "Drink now",
      value: 147,
    });
  });
});

describe("CellarCounters", () => {
  const roots: Root[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
  });

  async function mount(activeFilter: string, onSelect: (id: string) => void) {
    const counters = buildCellarCounters({ ...baseAlerts, drinkNowCount: 147 });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <CellarCounters
          counters={counters}
          activeFilter={activeFilter as never}
          onSelect={onSelect as never}
        />,
      );
    });
    return container;
  }

  it("renders every counter as a tab with real button semantics and a 44px touch target", async () => {
    const container = await mount("all", vi.fn());
    expect(container.querySelector('[role="tablist"]')?.getAttribute("aria-label")).toBe(
      "Cellar counters",
    );
    const tabs = [...container.querySelectorAll('[role="tab"]')];
    expect(tabs).toHaveLength(4); // all, open, out, drink-now (low is 0 → hidden)
    for (const tab of tabs) {
      expect(tab.tagName).toBe("BUTTON");
      expect(tab.getAttribute("type")).toBe("button");
      expect(tab.className).toContain("min-h-11");
    }
  });

  it("marks the active filter's tab as selected and others as not", async () => {
    const container = await mount("out", vi.fn());
    const tabs = [...container.querySelectorAll('[role="tab"]')];
    const selected = tabs.filter((tab) => tab.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toContain("86'd");
  });

  it("tapping a counter calls onSelect with that counter's filter id", async () => {
    const onSelect = vi.fn();
    const container = await mount("all", onSelect);
    const openTab = [...container.querySelectorAll('[role="tab"]')].find((tab) =>
      tab.textContent?.includes("Open"),
    )!;
    await act(async () => openTab.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("open");
  });

  it("uses the theme accent outline focus color on the active tab, matching the inactive tabs (residuals audit — was beige)", async () => {
    const container = await mount("all", vi.fn());
    const tabs = [...container.querySelectorAll('[role="tab"]')];
    const selected = tabs.find((tab) => tab.getAttribute("aria-selected") === "true")!;
    const unselected = tabs.find((tab) => tab.getAttribute("aria-selected") === "false")!;
    for (const tab of [selected, unselected]) {
      const classes = tab.className.split(/\s+/);
      expect(classes).toContain("focus-visible:outline-accent");
      expect(classes).not.toContain("focus-visible:outline-beige");
    }
  });
});
