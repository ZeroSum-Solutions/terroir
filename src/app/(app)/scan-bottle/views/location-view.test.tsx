import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MatchedWine } from "../scan-bottle-state";
import { LocationView } from "./location-view";

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

describe("LocationView", () => {
  it("disables Save location until both fields are filled, and shows a Back button", async () => {
    const onBack = vi.fn();
    await act(async () => {
      root.render(
        <LocationView
          wine={testWine}
          section=""
          binLocation=""
          onSectionChange={vi.fn()}
          onBinLocationChange={vi.fn()}
          onSubmit={vi.fn()}
          onBack={onBack}
          confirming={false}
        />,
      );
    });

    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toContain("Save location");

    const backButton = container.querySelector('button[type="button"]') as HTMLButtonElement;
    await act(async () => backButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("enables Save location with both fields, and disables/labels it while confirming", async () => {
    await act(async () => {
      root.render(
        <LocationView
          wine={testWine}
          section="Red Room"
          binLocation="A-1"
          onSectionChange={vi.fn()}
          onBinLocationChange={vi.fn()}
          onSubmit={vi.fn()}
          onBack={vi.fn()}
          confirming
        />,
      );
    });
    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toContain("Saving...");
  });
});
