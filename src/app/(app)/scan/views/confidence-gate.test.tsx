import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanQuality } from "@/lib/scanner/types";
import { ConfidenceGateView } from "./confidence-gate";

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

function baseQuality(overrides: Partial<ScanQuality> = {}): ScanQuality {
  return {
    avgConfidence: 0.9,
    lowConfidenceItems: 0,
    totalItems: 3,
    manualFallbackTriggered: true,
    ...overrides,
  };
}

async function renderGate(quality: ScanQuality) {
  await act(async () => {
    root.render(
      <ConfidenceGateView
        quality={quality}
        onReviewResults={vi.fn()}
        onManualEntry={vi.fn()}
      />,
    );
  });
}

describe("ConfidenceGateView", () => {
  it("shows dedicated copy for an arithmetic mismatch instead of a confidence message", async () => {
    await renderGate(baseQuality({ reason: "arithmetic_mismatch" }));

    expect(container.textContent).toContain("This invoice needs a second look");
    expect(container.textContent).toContain("don't add up");
    // Must not fall back to the misleading confidence-based copy.
    expect(container.textContent).not.toContain("low confidence");
    expect(container.textContent).not.toContain("average confidence");
  });

  it("still shows the low-confidence copy when that's the actual reason", async () => {
    await renderGate(
      baseQuality({ reason: undefined, lowConfidenceItems: 2, avgConfidence: 0.6 }),
    );

    expect(container.textContent).toContain("This invoice was harder to read");
    expect(container.textContent).toContain("2 of 3 wines have low confidence");
    expect(container.textContent).not.toContain("don't add up");
  });

  it("still shows the too-few-items copy when that's the actual reason", async () => {
    await renderGate(baseQuality({ reason: "too_few_items", totalItems: 1 }));

    expect(container.textContent).toContain("Only 1 wine found");
  });
});
