import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManualView } from "./manual-view";

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

describe("ManualView", () => {
  it("disables submit until a code is entered, and reports changes", async () => {
    const onManualCodeChange = vi.fn();
    const onSubmit = vi.fn();
    const onUseCamera = vi.fn();
    await act(async () => {
      root.render(
        <ManualView
          manualCode=""
          onManualCodeChange={onManualCodeChange}
          onSubmit={onSubmit}
          onUseCamera={onUseCamera}
        />,
      );
    });

    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    const input = container.querySelector("#manual-code") as HTMLInputElement;
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      nativeSetter.call(input, "ABC123");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onManualCodeChange).toHaveBeenCalledWith("ABC123");

    const useCameraButton = container.querySelector('button[type="button"]') as HTMLButtonElement;
    await act(async () => useCameraButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onUseCamera).toHaveBeenCalledTimes(1);
  });

  it("enables submit once a non-blank code is present", async () => {
    await act(async () => {
      root.render(
        <ManualView manualCode="ABC" onManualCodeChange={vi.fn()} onSubmit={vi.fn()} onUseCamera={vi.fn()} />,
      );
    });
    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
  });
});
