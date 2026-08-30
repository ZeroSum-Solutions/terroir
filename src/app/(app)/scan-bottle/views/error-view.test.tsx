import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorView } from "./error-view";

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

describe("ErrorView", () => {
  it("offers manual entry when the failure has no payload (e.g. camera lookup)", async () => {
    const onTryAgain = vi.fn();
    const onManualEntry = vi.fn();
    await act(async () => {
      root.render(
        <ErrorView error="Wine not found." payload={null} onTryAgain={onTryAgain} onManualEntry={onManualEntry} />,
      );
    });

    expect(container.textContent).toContain("Wine not found.");
    expect(container.textContent).toContain("Enter code manually");

    const [tryAgain, manual] = container.querySelectorAll("button");
    await act(async () => tryAgain.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onTryAgain).toHaveBeenCalledTimes(1);
    await act(async () => manual.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onManualEntry).toHaveBeenCalledTimes(1);
  });

  it("hides manual entry and shows the failed code when a payload was already decoded", async () => {
    await act(async () => {
      root.render(
        <ErrorView error="Wine not found." payload="QR-999" onTryAgain={vi.fn()} onManualEntry={vi.fn()} />,
      );
    });
    expect(container.textContent).toContain("Code: QR-999");
    expect(container.textContent).not.toContain("Enter code manually");
    expect(container.querySelectorAll("button").length).toBe(1);
  });
});
