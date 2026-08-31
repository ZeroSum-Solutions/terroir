import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PriceStepper } from "./price-stepper";

const roots: Root[] = [];
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
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
});

async function render(props: React.ComponentProps<typeof PriceStepper>) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<PriceStepper {...props} />));
  return container;
}

function control(container: HTMLElement, label: string) {
  return container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
}

describe("PriceStepper", () => {
  it("shows the suggestion, marked as one, when no price is stored", async () => {
    const container = await render({
      value: null,
      suggested: 175,
      label: "bottle price for Barolo",
      onChange: vi.fn(),
    });

    expect(control(container, "Edit bottle price for Barolo").textContent).toBe(
      "$175",
    );
    expect(container.textContent).toContain("Suggested");
    expect(control(container, "Edit bottle price for Barolo").className).toContain(
      "italic",
    );
  });

  it("shows a dash only when no suggestion can be computed", async () => {
    const container = await render({
      value: null,
      suggested: null,
      label: "bottle price for Barolo",
      onChange: vi.fn(),
    });

    expect(control(container, "Edit bottle price for Barolo").textContent).toBe("—");
    expect(container.textContent).not.toContain("Suggested");
    expect(control(container, "Increase bottle price for Barolo").disabled).toBe(
      true,
    );
  });

  it("does not mark a stored price as a suggestion", async () => {
    const container = await render({
      value: 180,
      suggested: 175,
      label: "bottle price for Barolo",
      onChange: vi.fn(),
    });

    expect(control(container, "Edit bottle price for Barolo").textContent).toBe(
      "$180",
    );
    expect(container.textContent).not.toContain("Suggested");
  });

  it("steps a dollar at a time", async () => {
    const onChange = vi.fn();
    const container = await render({
      value: 180,
      label: "bottle price for Barolo",
      onChange,
    });

    await act(async () => control(container, "Increase bottle price for Barolo").click());
    expect(onChange).toHaveBeenLastCalledWith(181);

    await act(async () => control(container, "Decrease bottle price for Barolo").click());
    expect(onChange).toHaveBeenLastCalledWith(179);
  });

  it("commits the suggestion on the first step, turning it into a price", async () => {
    const onChange = vi.fn();
    const container = await render({
      value: null,
      suggested: 175,
      label: "bottle price for Barolo",
      onChange,
    });

    await act(async () => control(container, "Increase bottle price for Barolo").click());
    expect(onChange).toHaveBeenCalledWith(176);
  });

  it("never steps below zero", async () => {
    const onChange = vi.fn();
    const container = await render({
      value: 0,
      label: "glass price for Barolo",
      onChange,
    });

    await act(async () => control(container, "Decrease glass price for Barolo").click());
    expect(onChange).toHaveBeenCalledWith(0);
  });

  it("keeps every control at the 44px touch floor", async () => {
    const container = await render({
      value: 24,
      label: "glass price for Barolo",
      onChange: vi.fn(),
    });

    for (const label of [
      "Decrease glass price for Barolo",
      "Edit glass price for Barolo",
      "Increase glass price for Barolo",
    ]) {
      expect(control(container, label).className).toMatch(/\b(h-11|min-h-11)\b/);
    }
  });

  it("edits to an exact number without twelve taps", async () => {
    const onChange = vi.fn();
    const container = await render({
      value: null,
      suggested: 175,
      label: "bottle price for Barolo",
      onChange,
    });

    await act(async () => control(container, "Edit bottle price for Barolo").click());
    const input = container.querySelector<HTMLInputElement>("input")!;
    expect(input.value).toBe("175");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "199.5",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // React maps onBlur onto the bubbling focusout event.
    await act(async () =>
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })),
    );

    expect(onChange).toHaveBeenCalledWith(199.5);
  });
});
