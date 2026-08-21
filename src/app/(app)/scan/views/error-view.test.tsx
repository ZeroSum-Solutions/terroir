import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorView } from "./error-view";

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

describe("ErrorView", () => {
  it("offers invoice-specific retry and manual recovery in an alert", async () => {
    await renderError("invoice");

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Couldn’t read the invoice");
    expect(alert?.textContent).toContain("Retry invoice scan");
    expect(alert?.textContent).toContain("Enter manually");
    expect(alert?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expectAllInteractiveTargetsAreAtLeast44px();
  });

  it("offers label-specific retry without constructing invoice manual entry", async () => {
    await renderError("bottle");

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Couldn’t read the label");
    expect(alert?.textContent).toContain("Retry label scan");
    expect(alert?.textContent).toContain("New photo");
    expect(alert?.textContent).not.toContain("Enter manually");
    expect(alert?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expectAllInteractiveTargetsAreAtLeast44px();
  });
});

async function renderError(mode: "invoice" | "bottle") {
  await act(async () => {
    root.render(
      <ErrorView
        mode={mode}
        message="Try a clearer photo."
        onRetry={vi.fn()}
        onNewPhoto={vi.fn()}
        hasFile
        onManual={vi.fn()}
      />,
    );
  });
}

function expectAllInteractiveTargetsAreAtLeast44px() {
  for (const element of container.querySelectorAll<HTMLElement>("button, a")) {
    expect(element.className).not.toMatch(/(?:^|\s)md:h-\[(?:3[0-9]|4[0-3])px\]/);
    expect(element.className).toMatch(/(?:^|\s)(?:min-h-11|h-11|h-12)(?:\s|$)/);
  }
}
