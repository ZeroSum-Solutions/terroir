import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Scan } from "@/lib/scanner/types";
import { ResultsView } from "./results-view";

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

beforeEach(() => {
  vi.stubGlobal("confirm", vi.fn().mockReturnValue(false));
});

describe("ResultsView discard confirmation", () => {
  const roots: Root[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
    document.body.style.overflow = "";
    vi.unstubAllGlobals();
  });

  it.each(["Clear", "Scan another"])(
    "routes %s through the shared discard confirmation",
    async (triggerLabel) => {
      const onScanAnother = vi.fn();
      const { container } = await mount(
        <ResultsView {...resultProps({ onScanAnother })} />,
      );

      await click(buttonContaining(container, triggerLabel));
      expect(onScanAnother).not.toHaveBeenCalled();
      const dialog = dialogByTitle(container, "Discard scan");
      expect(dialog).toBeDefined();
      expect(dialog!.textContent).toContain("all edits will be lost");

      await click(button(dialog!, "Discard scan"));
      expect(onScanAnother).toHaveBeenCalledOnce();
      expect(dialogByTitle(container, "Discard scan")).toBeUndefined();
    },
  );

  it("cancels a discard without clearing the scan", async () => {
    const onScanAnother = vi.fn();
    const { container } = await mount(
      <ResultsView {...resultProps({ onScanAnother })} />,
    );

    await click(buttonContaining(container, "Clear"));
    const dialog = dialogByTitle(container, "Discard scan")!;
    await click(button(dialog, "Cancel"));

    expect(onScanAnother).not.toHaveBeenCalled();
    expect(dialogByTitle(container, "Discard scan")).toBeUndefined();
  });

  async function mount(element: ReactElement) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(element));
    return { container, root };
  }
});

function resultProps(overrides: { onScanAnother: () => void }) {
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
    edits: { "item-1:name": true },
    rawText: "Test invoice text",
  };

  return {
    scan,
    onUpdate: vi.fn(),
    onUpdateSource: vi.fn(),
    onRemove: vi.fn(),
    onScanAnother: overrides.onScanAnother,
    onExportCsv: vi.fn(),
    onExportAccuracy: vi.fn(),
    onSaveToInventory: vi.fn(),
    isSaving: false,
  };
}

function dialogByTitle(root: ParentNode, title: string) {
  return [...root.querySelectorAll<HTMLElement>('[role="dialog"]')].find(
    (dialog) => dialog.querySelector("h2")?.textContent === title,
  );
}

function button(root: ParentNode, name: string) {
  return [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === name,
  )!;
}

function buttonContaining(root: ParentNode, name: string) {
  return [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.includes(name),
  )!;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}
