import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildCellarCounters,
  CellarScopeSelect,
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

describe("CellarScopeSelect", () => {
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
        <CellarScopeSelect
          counters={counters}
          activeFilter={activeFilter as never}
          onSelect={onSelect as never}
        />,
      );
    });
    return container;
  }

  /**
   * GLOBAL-01. These counters were a strip of pills: 424px of a 354px row at
   * 390px with four of them, ~670px with six, which is why three of the
   * cellar's ten controls were on screen and seven were not. One select is
   * constant-width whatever the data — and it still shows every number.
   */
  it("renders one control carrying every counter and its count", async () => {
    const container = await mount("all", vi.fn());
    const selects = [...container.querySelectorAll("select")];
    expect(selects).toHaveLength(1);
    expect(selects[0].getAttribute("aria-label")).toBe("Cellar scope");
    expect(selects[0].className).toContain("h-11");

    const options = [...selects[0].querySelectorAll("option")];
    expect(options.map((option) => option.value)).toEqual([
      "all",
      "open",
      "out",
      "drink-now",
    ]); // low is 0 → suppressed
    expect(options[0].textContent).toContain("1,364");
    expect(options[3].textContent).toContain("Drink now");
    expect(options[3].textContent).toContain("147");
  });

  it("shows the active filter as the selected value", async () => {
    const container = await mount("out", vi.fn());
    const select = container.querySelector("select")!;
    expect(select.value).toBe("out");
  });

  it("choosing a scope calls onSelect with that counter's filter id", async () => {
    const onSelect = vi.fn();
    const container = await mount("all", onSelect);
    const select = container.querySelector<HTMLSelectElement>("select")!;
    await act(async () => {
      select.value = "open";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("open");
  });

  it("uses the theme accent outline focus color, not a ring utility", async () => {
    const container = await mount("all", vi.fn());
    const select = container.querySelector("select")!;
    expect(select.className.split(/\s+/)).toContain("focus-ring");
    expect(select.className).not.toMatch(/focus(-visible)?:(ring|outline)/);
  });
});
