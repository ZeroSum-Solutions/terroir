import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

const { SortControls } = await import("./sort-controls");

describe("SortControls", () => {
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

  it.each([
    [{ field: null, dir: null }, "?sort=variance&ord=desc"],
    [{ field: "variance", dir: "desc" }, "?sort=variance&ord=asc"],
    [{ field: "variance", dir: "asc" }, "?"],
  ] as const)("cycles the variance sort from %o", async (current, expected) => {
    await act(async () => root.render(<SortControls current={current} />));

    await act(async () => container.querySelector("button")?.click());

    expect(mockPush).toHaveBeenCalledWith(expected);
  });
});
