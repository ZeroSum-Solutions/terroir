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
          locationError={null}
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

  /**
   * SD-10 — a refused save used to tear the operator out to the `error` view,
   * headed "Lookup failed", discarding the bin they had just typed. The
   * failure belongs here, next to the fields, the way the correction search
   * already reports its own.
   */
  it("reports a failed save in place, keeping the typed section and bin", async () => {
    await act(async () => {
      root.render(
        <LocationView
          wine={testWine}
          section="Red Room"
          binLocation="A-1"
          locationError="Bin A-1 is already full."
          onSectionChange={vi.fn()}
          onBinLocationChange={vi.fn()}
          onSubmit={vi.fn()}
          onBack={vi.fn()}
          confirming={false}
        />,
      );
    });

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Bin A-1 is already full.");
    expect(container.querySelector<HTMLInputElement>("#bottle-section")?.value).toBe("Red Room");
    expect(container.querySelector<HTMLInputElement>("#bottle-bin")?.value).toBe("A-1");
    expect(container.textContent).not.toContain("Lookup failed");
  });

  it("shows no alert when there is no save error", async () => {
    await act(async () => {
      root.render(
        <LocationView
          wine={testWine}
          section="Red Room"
          binLocation="A-1"
          locationError={null}
          onSectionChange={vi.fn()}
          onBinLocationChange={vi.fn()}
          onSubmit={vi.fn()}
          onBack={vi.fn()}
          confirming={false}
        />,
      );
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("enables Save location with both fields, and disables/labels it while confirming", async () => {
    await act(async () => {
      root.render(
        <LocationView
          wine={testWine}
          section="Red Room"
          binLocation="A-1"
          locationError={null}
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
