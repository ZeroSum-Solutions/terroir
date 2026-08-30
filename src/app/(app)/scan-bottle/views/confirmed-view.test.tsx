import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MatchedWine } from "../scan-bottle-state";
import { ConfirmedView } from "./confirmed-view";

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

const testWine: MatchedWine = {
  id: "wine-1",
  producer: "Test Producer",
  name: "Test Wine",
  vintage: 2022,
  varietal: "Pinot Noir",
  region: "Willamette Valley",
  country: "United States",
};

describe("ConfirmedView", () => {
  it("hides the End session button when the session is empty", async () => {
    await act(async () => {
      root.render(
        <ConfirmedView
          wine={testWine}
          section="Red Room"
          binLocation="A-1"
          sessionCount={0}
          onScanAgain={vi.fn()}
          onEndSession={vi.fn()}
        />,
      );
    });
    expect(container.textContent).not.toContain("End session");
  });

  it("shows End session with the running count once the session has bottles", async () => {
    const onScanAgain = vi.fn();
    const onEndSession = vi.fn();
    await act(async () => {
      root.render(
        <ConfirmedView
          wine={testWine}
          section="Red Room"
          binLocation="A-1"
          sessionCount={3}
          onScanAgain={onScanAgain}
          onEndSession={onEndSession}
        />,
      );
    });
    expect(container.textContent).toContain("3");
    expect(container.textContent).toContain("scanned");

    const [scanAgainButton, endSessionButton] = container.querySelectorAll("button");
    await act(async () => scanAgainButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onScanAgain).toHaveBeenCalledTimes(1);
    await act(async () => endSessionButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onEndSession).toHaveBeenCalledTimes(1);
  });

  it("omits the location line when section/binLocation are both blank", async () => {
    await act(async () => {
      root.render(
        <ConfirmedView
          wine={testWine}
          section=""
          binLocation=""
          sessionCount={0}
          onScanAgain={vi.fn()}
          onEndSession={vi.fn()}
        />,
      );
    });
    expect(container.textContent).not.toContain("&middot;");
    // With no session count, the whole "Section · Bin" paragraph should be
    // absent — verified by there being no <p> after the wine name besides
    // the wine-detail paragraph itself.
    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs.length).toBe(1);
  });
});
