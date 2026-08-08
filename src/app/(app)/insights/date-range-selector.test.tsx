import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => new URLSearchParams("range=all"),
}));

const { default: DateRangeSelector } = await import("./date-range-selector");

describe("DateRangeSelector", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mockPush.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("offers the canonical custom quick selector and applies its dates", async () => {
    await act(async () => root.render(<DateRangeSelector />));

    const custom = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Custom",
    );
    expect(custom).toBeDefined();

    await act(async () => custom?.click());
    expect(container.querySelector("#dr-from")).not.toBeNull();
    expect(container.querySelector("#dr-to")).not.toBeNull();

    const apply = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Apply",
    );
    await act(async () => apply?.click());

    expect(mockPush).toHaveBeenCalledWith(
      expect.stringMatching(/^\/insights\?range=custom&from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/),
      { scroll: false },
    );
  });
});
