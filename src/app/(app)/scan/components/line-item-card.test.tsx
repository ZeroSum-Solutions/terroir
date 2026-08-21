import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { LineItem } from "@/lib/scanner/types";
import { LineItemCard } from "./line-item-card";

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
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = "";
});

describe("LineItemCard correction fields", () => {
  it("retains invalid unit-cost text and keeps remove touch sized", async () => {
    const { container } = await mount(
      <LineItemCard
        item={item}
        isLow={() => false}
        isEdited={() => false}
        onUpdate={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    const cost = container.querySelector<HTMLInputElement>("#line-line-1-unit-cost")!;

    expect(
      container.querySelector('label[for="line-line-1-unit-cost"]')?.textContent,
    ).toBe("Unit cost");
    await change(cost, "abc");
    await blur(cost);
    expect(cost.value).toBe("abc");
    expect(cost.getAttribute("aria-invalid")).toBe("true");
    expect(cost.getAttribute("aria-describedby")).toContain(
      "line-line-1-unit-cost-error",
    );

    const remove = container.querySelector<HTMLButtonElement>('button[aria-label^="Remove"]')!;
    expect(remove.className).toContain("min-h-11");
    expect(remove.className).toContain("min-w-11");
  });

  it("gives every mobile correction input one visible programmatic label", async () => {
    const { container } = await mount(
      <LineItemCard
        item={item}
        isLow={() => false}
        isEdited={() => false}
        onUpdate={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    const inputs = [...container.querySelectorAll<HTMLInputElement>("input")];
    expect(inputs).toHaveLength(6);
    for (const input of inputs) {
      const labels = container.querySelectorAll(`label[for="${input.id}"]`);
      expect(labels).toHaveLength(1);
      expect(labels[0].className).not.toContain("sr-only");
      expect(input.getAttribute("aria-label")).toBeNull();
      expect(input.className).toContain("min-h-11");
    }
  });
});

const item: LineItem = {
  id: "line-1",
  name: "Cabernet",
  producer: "Test Producer",
  vintage: 2022,
  varietal: "Cabernet Sauvignon",
  region: "Napa Valley",
  qty: 2,
  unitCost: 18,
  confidence: 0.95,
  lowFields: [],
};

async function mount(element: ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return { container, root };
}

async function change(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!
      .set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function blur(input: HTMLInputElement) {
  await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
}
