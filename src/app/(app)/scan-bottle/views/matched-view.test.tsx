import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MatchedWine } from "../scan-bottle-state";
import { MatchedView } from "./matched-view";

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

describe("MatchedView", () => {
  it("shows the matched wine's details and wires Correct/Confirm", async () => {
    const onCorrect = vi.fn();
    const onConfirm = vi.fn();
    await act(async () => {
      root.render(<MatchedView wine={wine()} onCorrect={onCorrect} onConfirm={onConfirm} />);
    });

    expect(container.textContent).toContain("Test Producer");
    expect(container.textContent).toContain("Test Wine");
    expect(container.textContent).toContain("2022");

    const [correctButton, confirmButton] = container.querySelectorAll("button");
    await act(async () => correctButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onCorrect).toHaveBeenCalledTimes(1);
    await act(async () => confirmButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("omits optional detail rows that are null", async () => {
    await act(async () => {
      root.render(
        <MatchedView
          wine={wine({ vintage: null, varietal: null, region: null, country: null })}
          onCorrect={vi.fn()}
          onConfirm={vi.fn()}
        />,
      );
    });
    expect(container.querySelector("dt")).toBeNull();
  });
});
