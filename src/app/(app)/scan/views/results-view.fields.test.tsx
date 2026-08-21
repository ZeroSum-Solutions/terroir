import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Scan } from "@/lib/scanner/types";
import { ResultsView } from "./results-view";

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousActEnvironment = reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT;
const roots: Root[] = [];

beforeAll(() => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = "";
});

describe("ResultsView correction field accessibility", () => {
  it("labels source fields by for/id and keeps every invoice input touch sized", async () => {
    const { container } = await mount(<ResultsView {...resultProps()} />);

    for (const [id, label] of [
      ["scan-supplier", "Supplier"],
      ["scan-invoice-number", "Invoice number"],
      ["scan-delivery-date", "Delivery date"],
    ]) {
      const input = container.querySelector<HTMLInputElement>(`#${id}`)!;
      expect(container.querySelector(`label[for="${id}"]`)?.textContent).toBe(label);
      expect(input.getAttribute("aria-label")).toBeNull();
      expect(input.className).toContain("min-h-11");
    }

    const correctionInputs = [
      ...container.querySelectorAll<HTMLInputElement>('input[id^="line-"]'),
    ];
    expect(correctionInputs.length).toBeGreaterThan(0);
    expect(new Set(correctionInputs.map((input) => input.id)).size).toBe(
      correctionInputs.length,
    );
    for (const input of correctionInputs) {
      expect(container.querySelectorAll(`label[for="${input.id}"]`)).toHaveLength(1);
      expect(input.getAttribute("aria-label")).toBeNull();
      expect(input.className).toContain("min-h-11");
    }
  });

  it("never shrinks invoice quantity or action targets below 44px", async () => {
    const { container } = await mount(<ResultsView {...resultProps()} />);

    for (const stepper of container.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Decrease quantity"], [aria-label="Increase quantity"]',
    )) {
      expect(stepper.className).toContain("h-11");
      expect(stepper.className).not.toContain("md:h-9");
    }

    for (const remove of container.querySelectorAll<HTMLButtonElement>(
      'button[aria-label^="Remove"]',
    )) {
      expect(remove.className).toContain("min-h-11");
      expect(remove.className).toContain("min-w-11");
    }

    for (const name of ["Clear", "Scan another", "CSV", "JSON", "Save to Inventory"]) {
      const action = buttonContaining(container, name);
      expect(action.className).toContain("min-h-11");
      expect(action.className).not.toContain("md:h-[38px]");
    }
  });
});

function resultProps() {
  const scan: Scan = {
    source: {
      distributor: "Test Distributor",
      invoiceNo: "INV-42",
      invoiceDate: "2026-08-20",
      parsedAt: "2026-08-20T12:00:00.000Z",
    },
    items: [
      {
        id: "item-1",
        name: "Test Wine",
        producer: "Test Producer",
        vintage: 2024,
        varietal: "Pinot Noir",
        region: "Willamette Valley",
        qty: 2,
        unitCost: 24,
        confidence: 0.98,
        lowFields: [],
      },
    ],
    edits: {},
  };

  return {
    scan,
    onUpdate: vi.fn(),
    onUpdateSource: vi.fn(),
    onRemove: vi.fn(),
    onScanAnother: vi.fn(),
    onExportCsv: vi.fn(),
    onExportAccuracy: vi.fn(),
    onSaveToInventory: vi.fn(),
    isSaving: false,
  };
}

async function mount(element: ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return { container, root };
}

function buttonContaining(root: ParentNode, name: string) {
  return [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.includes(name),
  )!;
}
