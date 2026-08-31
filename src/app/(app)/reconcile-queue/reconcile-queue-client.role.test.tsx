import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ReconcileQueueClient } from "./reconcile-queue-client";
import type { QueueResponse } from "./types";

/**
 * Accepting and undoing a reconcile batch are owner/manager only —
 * `POST /api/reconcile-queue/accept` and `.../undo` both call
 * `requireRole(["owner", "manager"])`. Reading the queue is not.
 *
 * The page used to render the bulk rail, the undo button, the per-row
 * checkbox and the bin picker for every member, so a staff user could work
 * through the whole selection flow and learn it was refused only from the
 * 403 that came back. These lock the affordance to the permission.
 */
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

async function render(canManage: boolean): Promise<HTMLElement> {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(queueResponse()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<ReconcileQueueClient canManage={canManage} />));
  await vi.waitFor(() => {
    expect(container.querySelectorAll("[data-queue-row]").length).toBeGreaterThan(0);
  });
  return container;
}

function buttonTexts(container: HTMLElement): string[] {
  return [...container.querySelectorAll("button")].map(
    (button) => button.textContent ?? "",
  );
}

describe("ReconcileQueueClient role affordance", () => {
  it("offers accept, undo, selection and bin placement to a manager", async () => {
    const container = await render(true);
    const texts = buttonTexts(container);
    expect(texts.some((text) => text.includes("Accept"))).toBe(true);
    expect(texts.some((text) => text.includes("Undo latest batch"))).toBe(true);
    expect(texts.some((text) => text.includes("Select actionable"))).toBe(true);
    expect(container.querySelectorAll("input[type=checkbox]")).toHaveLength(1);
    expect(container.querySelectorAll("select")).toHaveLength(1);
  });

  it("offers a staff member no control the API would refuse", async () => {
    const container = await render(false);
    const texts = buttonTexts(container);
    expect(texts.some((text) => text.includes("Accept"))).toBe(false);
    expect(texts.some((text) => text.includes("Undo latest batch"))).toBe(false);
    expect(texts.some((text) => text.includes("Select actionable"))).toBe(false);
    expect(container.querySelectorAll("input[type=checkbox]")).toHaveLength(0);
    expect(container.querySelectorAll("select")).toHaveLength(0);
    // The queue itself stays readable — GET only requires membership.
    expect(container.querySelectorAll("[data-queue-row]")).toHaveLength(1);
    expect(container.textContent).toContain("Place in bin");
  });
});

function queueResponse(): QueueResponse {
  return {
    issues: [
      {
        id: "issue-1",
        kind: "unplaced",
        subjectTable: "inventory_items",
        subjectId: "inventory-1",
        title: "Wine 1",
        detail: "Needs a bin",
        units: 1,
        unitCost: 20,
        atRisk: 20,
        action: { type: "place_bin", label: "Place in bin", targetId: "inventory-1" },
      },
    ],
    summary: { itemCount: 1, unitCount: 1, atRisk: 20 },
    latest_batch: { id: "batch-1", action_count: 1, created_at: "2026-08-30T00:00:00.000Z" },
    bins: [{ id: "bin-1", code: "A-1", zone: "Main" }],
  };
}
