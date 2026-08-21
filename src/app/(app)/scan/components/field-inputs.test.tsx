import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MoneyInput, VintageInput } from "./field-inputs";

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

describe("invoice correction field drafts", () => {
  it("keeps an invalid vintage draft until the operator corrects it", async () => {
    const onCommit = vi.fn();
    const { container } = await mount(
      <VintageInput
        id="line-1-vintage"
        label="Vintage"
        value={2022}
        onCommit={onCommit}
      />,
    );
    const input = container.querySelector<HTMLInputElement>("#line-1-vintage");
    expect(input).not.toBeNull();

    await change(input!, "twenty-two");
    await blur(input!);

    expect(input!.value).toBe("twenty-two");
    expect(input!.getAttribute("aria-invalid")).toBe("true");
    expect(input!.getAttribute("aria-describedby")).toContain("line-1-vintage-error");
    expect(document.getElementById("line-1-vintage-error")?.textContent).toBe(
      "Enter a year or NV.",
    );
    expect(onCommit).not.toHaveBeenCalled();

    await change(input!, "2023");
    await blur(input!);
    expect(input!.getAttribute("aria-invalid")).toBeNull();
    expect(container.querySelector("#line-1-vintage-error")).toBeNull();
    expect(onCommit).toHaveBeenCalledWith(2023);
  });

  it("clears the linked money error after a valid correction", async () => {
    const onCommit = vi.fn();
    const { container } = await mount(
      <MoneyInput
        id="line-1-unit-cost"
        label="Unit cost"
        value={12}
        onCommit={onCommit}
      />,
    );
    const input = container.querySelector<HTMLInputElement>("#line-1-unit-cost");
    expect(input).not.toBeNull();

    await change(input!, "abc");
    await blur(input!);
    expect(input!.value).toBe("abc");
    expect(input!.getAttribute("aria-invalid")).toBe("true");
    expect(onCommit).not.toHaveBeenCalled();

    await change(input!, "14.25");
    await blur(input!);
    expect(input!.getAttribute("aria-invalid")).toBeNull();
    expect(container.querySelector("#line-1-unit-cost-error")).toBeNull();
    expect(onCommit).toHaveBeenCalledWith(14.25);
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
