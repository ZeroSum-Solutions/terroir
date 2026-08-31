import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ReconcileQueueClient } from "./reconcile-queue-client";
import type { QueueResponse } from "./types";

const roots: Root[] = [];
const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousActEnvironment = reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT;

beforeAll(() => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = "";
});

describe("ReconcileQueueClient mobile rendering", () => {
  it("reveals a large queue incrementally through a phone-sized control", async () => {
    const data = queueResponse(60);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(data), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<ReconcileQueueClient canManage />));

    await vi.waitFor(() => {
      expect(container.querySelectorAll("[data-queue-row]")).toHaveLength(25);
    });
    const showMore = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Show 25 more"),
    );
    expect(showMore).not.toBeUndefined();
    expect(showMore?.className).toContain("min-h-11");
    expect(showMore?.textContent).toContain("25 of 60");

    await act(async () => showMore?.click());
    expect(container.querySelectorAll("[data-queue-row]")).toHaveLength(50);
  });
});

function queueResponse(count: number): QueueResponse {
  const issues = Array.from({ length: count }, (_, index) => ({
    id: `issue-${index}`,
    kind: "unplaced" as const,
    subjectTable: "inventory_items",
    subjectId: `inventory-${index}`,
    title: `Wine ${index}`,
    detail: "Needs a bin",
    units: 1,
    unitCost: count - index,
    atRisk: count - index,
  }));
  return {
    issues,
    summary: { itemCount: count, unitCount: count, atRisk: count * count },
    latest_batch: null,
    bins: [{ id: "bin-1", code: "A-1", zone: "Main" }],
  };
}
