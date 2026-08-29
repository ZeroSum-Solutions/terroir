import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RouteDataEmpty, RouteDataError, RouteDataLoading } from "./route-data-state";

const routeBoundaries = [
  {
    surface: "Lists",
    errorTitle: "Wine lists couldn't be loaded",
    errorDescription: "The request failed. Your lists have not been changed.",
    loadingLabel: "Loading wine lists",
    importError: () => import("@/app/(app)/lists/(index)/error"),
    importLoading: () => import("@/app/(app)/lists/(index)/loading"),
  },
  {
    surface: "Open Bottles",
    errorTitle: "Open bottles couldn't be loaded",
    errorDescription: "The request failed. Your open bottles have not been changed.",
    loadingLabel: "Loading open bottles",
    importError: () => import("@/app/(app)/cellar/open/error"),
    importLoading: () => import("@/app/(app)/cellar/open/loading"),
  },
  {
    surface: "Reconciliation History",
    errorTitle: "Reconciliation history couldn't be loaded",
    errorDescription: "The request failed. Your reconciliation history has not been changed.",
    loadingLabel: "Loading reconciliation history",
    importError: () => import("@/app/(app)/cellar/reconcile/history/error"),
    importLoading: () => import("@/app/(app)/cellar/reconcile/history/loading"),
  },
  {
    surface: "Distributor Pricing",
    errorTitle: "Distributor pricing couldn't be loaded",
    errorDescription: "The request failed. Your distributor pricing has not been changed.",
    loadingLabel: "Loading distributor pricing",
    importError: () => import("@/app/(app)/price-comparison/error"),
    importLoading: () => import("@/app/(app)/price-comparison/loading"),
  },
  {
    surface: "Team",
    errorTitle: "Team couldn't be loaded",
    errorDescription: "The request failed. Your team has not been changed.",
    loadingLabel: "Loading team",
    importError: () => import("@/app/(app)/team/(index)/error"),
    importLoading: () => import("@/app/(app)/team/(index)/loading"),
  },
] as const;

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("route data states", () => {
  it("announces loading work with a polite busy status", async () => {
    const container = await render(
      <RouteDataLoading label="Loading cellar">
        <div data-testid="cellar-skeleton" />
      </RouteDataLoading>,
    );

    const status = container.querySelector('[role="status"]');

    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.getAttribute("aria-busy")).toBe("true");
    expect(status?.textContent).toContain("Loading cellar");
    expect(container.querySelector('[data-testid="cellar-skeleton"]')).not.toBeNull();
  });

  it("alerts with the supplied recovery copy and retries once", async () => {
    const onRetry = vi.fn();
    const container = await render(
      <RouteDataError
        title="Cellar unavailable"
        description="We could not load your cellar."
        onRetry={onRetry}
      />,
    );

    const alert = container.querySelector('[role="alert"]');
    const retryButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Try again",
    );

    expect(alert?.textContent).toContain("Cellar unavailable");
    expect(alert?.textContent).toContain("We could not load your cellar.");
    expect(retryButton?.className).toContain("h-11");

    await act(async () => retryButton?.click());

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("shows empty content without alert or loading urgency", async () => {
    const container = await render(
      <RouteDataEmpty
        icon={<span aria-hidden>○</span>}
        title="No wines yet"
        description="Add your first bottle to start tracking inventory."
        action={<button type="button">Add a bottle</button>}
      />,
    );

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.textContent).toContain("No wines yet");
    expect(container.textContent).toContain("Add your first bottle");
    expect(container.textContent).not.toContain("Loading");
  });
});

describe.each(routeBoundaries)("$surface route data boundary", (boundary) => {
  it("shows surface-specific recovery copy and delegates retry", async () => {
    const { default: ErrorBoundary } = await boundary.importError();
    const unstableRetry = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const container = await render(
      <ErrorBoundary error={new Error("private failure detail")} unstable_retry={unstableRetry} />,
    );

    const alert = container.querySelector('[role="alert"]');
    const retryButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Try again",
    );

    expect(alert?.textContent).toContain(boundary.errorTitle);
    expect(alert?.textContent).toContain(boundary.errorDescription);
    expect(alert?.textContent).not.toContain("private failure detail");

    await act(async () => retryButton?.click());

    expect(unstableRetry).toHaveBeenCalledTimes(1);
  });

  it("announces its loading skeleton as busy", async () => {
    const { default: LoadingBoundary } = await boundary.importLoading();

    const container = await render(<LoadingBoundary />);
    const status = container.querySelector('[role="status"]');

    expect(status?.getAttribute("aria-busy")).toBe("true");
    expect(status?.textContent).toContain(boundary.loadingLabel);
  });
});

async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(node);
  });

  return container;
}
