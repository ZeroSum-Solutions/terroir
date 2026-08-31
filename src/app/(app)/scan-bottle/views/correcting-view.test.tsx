import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MatchedWine } from "../scan-bottle-state";
import { CorrectingView } from "./correcting-view";

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

function wine(overrides: Partial<MatchedWine> = {}): MatchedWine {
  return {
    id: "wine-1",
    producer: "Test Producer",
    name: "Test Wine",
    vintage: 2022,
    varietal: "Pinot Noir",
    region: "Willamette Valley",
    country: "United States",
    ...overrides,
  };
}

describe("CorrectingView", () => {
  it("shows a loading state while searching", async () => {
    await act(async () => {
      root.render(
        <CorrectingView
          searchQuery="pin"
          onSearchChange={vi.fn()}
          searching
          searchResults={[]}
          searchError={null}
          onSelect={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
    });
    expect(container.textContent).toContain("Searching...");
  });

  it("shows a no-results message once search settles empty", async () => {
    await act(async () => {
      root.render(
        <CorrectingView
          searchQuery="zzzzz"
          onSearchChange={vi.fn()}
          searching={false}
          searchResults={[]}
          searchError={null}
          onSelect={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
    });
    expect(container.textContent).toContain("No wines found");
  });

  it("lists results and reports a selection", async () => {
    const onSelect = vi.fn();
    await act(async () => {
      root.render(
        <CorrectingView
          searchQuery="pin"
          onSearchChange={vi.fn()}
          searching={false}
          searchResults={[wine()]}
          searchError={null}
          onSelect={onSelect}
          onCancel={vi.fn()}
        />,
      );
    });
    const resultButton = container.querySelector("li button") as HTMLButtonElement;
    expect(resultButton.textContent).toContain("Test Producer");
    await act(async () => resultButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSelect).toHaveBeenCalledWith(wine());
  });

  it("surfaces a failed search instead of reporting no results", async () => {
    await act(async () => {
      root.render(
        <CorrectingView
          searchQuery="esporao"
          onSearchChange={vi.fn()}
          searching={false}
          searchResults={[]}
          searchError="Search failed (500)"
          onSelect={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
    });
    const alert = container.querySelector('[role="alert"]') as HTMLElement;
    expect(alert.textContent).toContain("Search failed (500)");
    expect(container.textContent).not.toContain("No wines found");
  });

  it("reports Cancel", async () => {
    const onCancel = vi.fn();
    await act(async () => {
      root.render(
        <CorrectingView
          searchQuery=""
          onSearchChange={vi.fn()}
          searching={false}
          searchResults={[]}
          searchError={null}
          onSelect={vi.fn()}
          onCancel={onCancel}
        />,
      );
    });
    const cancelButton = container.querySelector('button[type="button"]') as HTMLButtonElement;
    await act(async () => cancelButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
