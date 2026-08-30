import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScanningView } from "./scanning-view";

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

describe("ScanningView", () => {
  it("renders a live video element and the manual-entry fallback", async () => {
    const onEnterCode = vi.fn();
    await act(async () => {
      root.render(<ScanningView videoRef={{ current: null }} onEnterCode={onEnterCode} />);
    });

    expect(container.querySelector("video")).not.toBeNull();
    expect(container.textContent).toContain("Point camera at QR code");

    const button = container.querySelector("button");
    await act(async () => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onEnterCode).toHaveBeenCalledTimes(1);
  });
});
