// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddWineModal } from "./add-wine-modal";

vi.mock("@/lib/hooks/use-focus-trap", () => ({
  useFocusTrap: vi.fn(),
}));

type PendingRequest = {
  resolve: (response: Response) => void;
  signal?: AbortSignal;
};

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("AddWineModal search", () => {
  let container: HTMLDivElement;
  let root: Root;
  let pending: Map<string, PendingRequest>;

  beforeEach(() => {
    vi.useFakeTimers();
    pending = new Map();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((resolve) => {
            pending.set(String(input), {
              resolve,
              signal: init?.signal ?? undefined,
            });
          }),
      ),
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("ignores an older response after a newer inventory search starts", async () => {
    await act(async () => {
      root.render(
        <AddWineModal
          sections={[{ id: "section-1", name: "Dinner" }]}
          activeSectionId="section-1"
          onAdd={vi.fn()}
          onClose={vi.fn()}
        />,
      );
    });
    const input = container.querySelector(
      'input[aria-label="Search wines"]',
    ) as HTMLInputElement;

    await act(async () => setInputValue(input, "first"));
    await act(async () => vi.advanceTimersByTime(300));
    const first = pending.get("/api/wines/search?q=first");
    expect(first).toBeDefined();

    await act(async () => setInputValue(input, "second"));
    expect(first?.signal?.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTime(300));
    const second = pending.get("/api/wines/search?q=second");
    expect(second).toBeDefined();

    await act(async () => {
      second?.resolve(
        Response.json([
          {
            id: "wine-second",
            name: "Second",
            producer: "Current",
            vintage: 2020,
            varietal: "Pinot Noir",
            region: "Burgundy",
          },
        ]),
      );
      await Promise.resolve();
    });
    await act(async () => {
      first?.resolve(
        Response.json([
          {
            id: "wine-first",
            name: "First",
            producer: "Stale",
            vintage: 2019,
            varietal: "Cabernet",
            region: "Napa",
          },
        ]),
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Current, Second");
    expect(container.textContent).not.toContain("Stale, First");
  });
});
