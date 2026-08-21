import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ML_PER_OZ } from "@/lib/units";
import type { OpenBottleRow } from "@/lib/wine-list/shapes";
import { PourPickerModal } from "./pour-picker-modal";

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

describe("PourPickerModal accessible drafts", () => {
  it("keeps an invalid custom pour and note editable with a linked error", async () => {
    const onConfirm = vi.fn();
    const { container } = await mount(
      <PourPickerModal item={bottle} onCancel={vi.fn()} onConfirm={onConfirm} />,
    );
    const custom = container.querySelector<HTMLInputElement>("#pour-picker-custom")!;
    const note = container.querySelector<HTMLTextAreaElement>("#pour-picker-note")!;

    expect(container.querySelector('label[for="pour-picker-custom"]')?.textContent).toBe(
      "Custom (oz)",
    );
    expect(custom.getAttribute("aria-label")).toBeNull();
    await change(custom, "0");
    await change(note, "VIP comp");

    const submit = button(container, "Pour");
    expect(submit.disabled).toBe(false);
    await click(submit);

    expect(custom.value).toBe("0");
    expect(note.value).toBe("VIP comp");
    expect(custom.getAttribute("aria-invalid")).toBe("true");
    expect(custom.getAttribute("aria-describedby")).toContain(
      "pour-picker-custom-error",
    );
    expect(container.querySelector("#pour-picker-custom-error")?.textContent).toBe(
      "Enter a pour greater than 0 oz.",
    );
    expect(onConfirm).not.toHaveBeenCalled();

    await change(custom, "5");
    expect(custom.getAttribute("aria-invalid")).toBeNull();
    await click(submit);
    expect(onConfirm.mock.calls[0]?.[0]).toBe(Math.round(5 * ML_PER_OZ));
  });

  it("clears local drafts on explicit Cancel", async () => {
    const onCancel = vi.fn();
    const { container } = await mount(
      <PourPickerModal item={bottle} onCancel={onCancel} onConfirm={vi.fn()} />,
    );
    const custom = container.querySelector<HTMLInputElement>("#pour-picker-custom")!;
    const note = container.querySelector<HTMLTextAreaElement>("#pour-picker-note")!;
    await change(custom, "0");
    await change(note, "VIP comp");
    await click(button(container, "Pour"));

    await click(button(container, "Cancel"));

    expect(onCancel).toHaveBeenCalledOnce();
    expect(custom.value).toBe("");
    expect(note.value).toBe("");
    expect(custom.getAttribute("aria-invalid")).toBeNull();
  });

  it("labels every migrated control and keeps every action touch sized", async () => {
    const { container } = await mount(
      <PourPickerModal item={bottle} onCancel={vi.fn()} onConfirm={vi.fn()} />,
    );

    for (const id of ["pour-picker-custom", "pour-picker-note"]) {
      const control = container.querySelector<HTMLElement>(`#${id}`)!;
      expect(container.querySelector(`label[for="${id}"]`)).not.toBeNull();
      expect(control.getAttribute("aria-label")).toBeNull();
      expect(control.className).toContain("min-h-11");
    }
    for (const name of ["1 oz", "3 oz", "5 oz", "8 oz", "Pour", "Cancel"]) {
      expect(button(container, name).className).toContain("min-h-11");
    }
  });
});

const bottle: OpenBottleRow = {
  wine_id: "wine-1",
  wine_list_item_id: "item-1",
  producer: "Test Producer",
  name: "Cabernet",
  vintage: 2022,
  size_ml: 750,
  sealed_count: 0,
  opened_at: "2026-08-20T12:00:00.000Z",
  open_remaining_ml: 500,
  glass_pour_ml: 148,
  pour_size_mode: "fixed",
};

async function mount(element: ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return { container, root };
}

function button(root: ParentNode, name: string) {
  return [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === name,
  )!;
}

async function change(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = input instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}
