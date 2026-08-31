import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { OverflowMenu } from "./overflow-menu";

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

describe("OverflowMenu", () => {
  const roots: Root[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    document.body.innerHTML = "";
  });

  async function mount(items: React.ComponentProps<typeof OverflowMenu>["items"]) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(<OverflowMenu label="More actions" items={items} />);
    });
    return container;
  }

  const trigger = (container: ParentNode) =>
    container.querySelector<HTMLButtonElement>('[aria-label="More actions"]')!;

  it("renders nothing at all when it has no items — an empty menu is a lie", async () => {
    const container = await mount([]);
    expect(container.innerHTML).toBe("");
  });

  it("keeps a 44px trigger and opens on click", async () => {
    const container = await mount([{ label: "Settings", onSelect: vi.fn() }]);
    expect(trigger(container).className).toContain("h-11");
    expect(trigger(container).className).toContain("w-11");
    expect(trigger(container).getAttribute("aria-expanded")).toBe("false");

    await act(async () => trigger(container).click());
    expect(trigger(container).getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[role="menu"]')?.getAttribute("aria-label")).toBe(
      "More actions",
    );
  });

  it("renders link items as anchors carrying download and new-tab intent", async () => {
    const container = await mount([
      { label: "CSV", href: "/api/csv", download: true },
      { label: "Print", href: "/print", external: true },
    ]);
    await act(async () => trigger(container).click());
    const [csv, print] = [
      ...container.querySelectorAll<HTMLAnchorElement>('a[role="menuitem"]'),
    ];
    expect(csv.getAttribute("download")).not.toBeNull();
    expect(print.target).toBe("_blank");
    expect(print.rel).toBe("noopener noreferrer");
  });

  it("closes on Escape, returning focus to the trigger", async () => {
    const container = await mount([{ label: "Settings", onSelect: vi.fn() }]);
    await act(async () => trigger(container).click());
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger(container));
  });

  it("closes on a click outside without running an item", async () => {
    const onSelect = vi.fn();
    const container = await mount([{ label: "Settings", onSelect }]);
    await act(async () => trigger(container).click());
    await act(async () => {
      document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("runs the item's action and closes", async () => {
    const onSelect = vi.fn();
    const container = await mount([{ label: "Settings", onSelect }]);
    await act(async () => trigger(container).click());
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click(),
    );
    expect(onSelect).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });
});
