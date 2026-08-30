import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoCameraView } from "./no-camera-view";

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

describe("NoCameraView", () => {
  it("explains the camera is unavailable and offers manual entry", async () => {
    const onEnterCode = vi.fn();
    await act(async () => {
      root.render(<NoCameraView onEnterCode={onEnterCode} />);
    });

    expect(container.textContent).toContain("Camera not available");

    const button = container.querySelector("button");
    await act(async () => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onEnterCode).toHaveBeenCalledTimes(1);
  });
});
