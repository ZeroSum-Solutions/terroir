import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BottleInventoryRow } from "@/lib/bins";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const { BinManager } = await import("./bin-manager");

const inventory: BottleInventoryRow[] = [
  {
    wineId: "wine-1",
    lineageId: null,
    name: "Estate Red",
    producer: "Demo Cellars",
    colour: "red",
    heroImageUrl: null,
    binId: "bin-1",
    binCode: "A5",
    binZone: "Cellar",
    quantity: 3,
  },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("BinManager bottle search", () => {
  it("opens the wine from a search result", async () => {
    await act(async () =>
      root.render(
        <BinManager
          bins={[]}
          inventory={inventory}
          canManage={false}
          unplacedCount={0}
        />,
      ),
    );
    const search = container.querySelector<HTMLInputElement>(
      'input[aria-label="Find a bottle"]',
    )!;
    setInputValue(search, "estate");

    const match = container.querySelector<HTMLElement>("[data-bottle-match]");
    expect(match, "the search returned nothing to tap").not.toBeNull();
    const link = match!.querySelector<HTMLAnchorElement>(
      'a[href="/cellar?wine=wine-1"]',
    );
    expect(link).not.toBeNull();
    expect(link?.className).toContain("min-h-11");
    expect(link?.textContent).toContain("Demo Cellars");
  });
});

describe("BinManager unplaced inventory", () => {
  it("sends unplaced stock to the queue that can place it, not back to itself", async () => {
    await act(async () =>
      root.render(
        <BinManager
          bins={[]}
          inventory={inventory}
          canManage={false}
          unplacedCount={4}
        />,
      ),
    );
    const link = container.querySelector<HTMLAnchorElement>("[data-unplaced-link]");
    expect(link, "the unplaced summary is missing").not.toBeNull();
    // Was <a id="unplaced" href="#unplaced"> — a link back to itself.
    expect(link!.getAttribute("href")).toBe("/reconcile-queue");
    expect(link!.getAttribute("id")).toBeNull();
    expect(link!.className).toContain("min-h-11");
    expect(link!.textContent).toContain("4 bottles");
  });

  it("renders nothing when every bottle is placed", async () => {
    await act(async () =>
      root.render(
        <BinManager
          bins={[]}
          inventory={inventory}
          canManage={false}
          unplacedCount={0}
        />,
      ),
    );
    expect(container.querySelector("[data-unplaced-link]")).toBeNull();
  });
});

function setInputValue(input: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  if (!setValue) throw new Error("Native input value setter is unavailable");
  act(() => {
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
