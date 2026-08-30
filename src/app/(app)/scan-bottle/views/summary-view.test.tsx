import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionScan } from "../scan-bottle-state";
import { SummaryView } from "./summary-view";

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

const scan: SessionScan = {
  wine: {
    id: "wine-1",
    producer: "Test Producer",
    name: "Test Wine",
    vintage: 2022,
    varietal: "Pinot Noir",
    region: "Willamette Valley",
    country: "United States",
  },
  section: "Red Room",
  binLocation: "A-1",
};

describe("SummaryView", () => {
  it("shows an empty-session message when nothing was scanned", async () => {
    await act(async () => {
      root.render(<SummaryView session={[]} onNewSession={vi.fn()} />);
    });
    expect(container.textContent).toContain("0 bottles scanned");
    expect(container.textContent).toContain("No bottles were scanned in this session.");
  });

  it("lists every scanned bottle with its location, and pluralizes correctly for one", async () => {
    await act(async () => {
      root.render(<SummaryView session={[scan]} onNewSession={vi.fn()} />);
    });
    expect(container.textContent).toContain("1 bottle scanned");
    expect(container.textContent).not.toContain("1 bottles");
    expect(container.textContent).toContain("Test Producer");
    expect(container.textContent).toContain("Red Room");
    expect(container.textContent).toContain("A-1");
  });

  it("reports Start new session", async () => {
    const onNewSession = vi.fn();
    await act(async () => {
      root.render(<SummaryView session={[scan]} onNewSession={onNewSession} />);
    });
    const button = container.querySelector("button") as HTMLButtonElement;
    await act(async () => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onNewSession).toHaveBeenCalledTimes(1);
  });
});
