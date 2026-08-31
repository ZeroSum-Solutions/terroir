// SD-41 — the preview half of the blank-producer guard.
//
// The server is what actually enforces the acknowledgement (see
// src/domains/import/producer-acknowledgement.ts and its confirm-level
// regression in batch-service.test.ts). These pin the affordance: Confirm
// cannot be pressed while blank-producer rows are unacknowledged, and the
// count the operator ticked is what reaches the confirm request.
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PreviewStep } from "./preview-step";
import { ZERO_SUMMARY, type ChunkUploadState } from "@/domains/import/chunked-upload-types";
import type { PreviewSummary } from "@/domains/import/preview-service";

const reactTestEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

function summary(overrides: Partial<PreviewSummary> = {}): PreviewSummary {
  return { ...ZERO_SUMMARY, validRows: 3, ...overrides };
}

function confirmButton(container: HTMLElement): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Confirm import"));
  if (!button) throw new Error("no Confirm import button rendered");
  return button;
}

function acknowledgeCheckbox(container: HTMLElement): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>('input[type="checkbox"]');
}

describe("PreviewStep — blank-producer gate (SD-41)", () => {
  const mountedRoots: Root[] = [];

  afterEach(async () => {
    for (const root of mountedRoots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
  });

  async function mount(element: ReactElement) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => root.render(element));
    return { container };
  }

  function props(overrides: Partial<Parameters<typeof PreviewStep>[0]> = {}) {
    return {
      filename: "cellar.csv",
      summary: summary(),
      errorRows: [],
      rowOverrides: {},
      onRowFieldChange: () => {},
      isRowLocked: () => false,
      chunkUpload: null as ChunkUploadState[] | null,
      onConfirm: () => {},
      confirming: false,
      onBack: () => {},
      error: null,
      ...overrides,
    };
  }

  it("renders no gate and confirms freely when every row has a producer", async () => {
    const onConfirm = vi.fn();
    const { container } = await mount(<PreviewStep {...props({ onConfirm })} />);

    expect(acknowledgeCheckbox(container)).toBeNull();
    expect(confirmButton(container).disabled).toBe(false);
    await act(async () => confirmButton(container).click());
    expect(onConfirm).toHaveBeenCalledWith(0);
  });

  // The whole point of SD-41: the old panel was role="status" and Confirm
  // stayed live beside it.
  it("DISABLES Confirm while blank-producer rows are unacknowledged", async () => {
    const onConfirm = vi.fn();
    const { container } = await mount(
      <PreviewStep {...props({ summary: summary({ missingProducerRows: 2 }), onConfirm })} />,
    );

    expect(container.textContent).toContain("2 rows have no producer");
    expect(confirmButton(container).disabled).toBe(true);
    await act(async () => confirmButton(container).click());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("enables Confirm once acknowledged, and hands the acknowledged COUNT to the confirm request", async () => {
    const onConfirm = vi.fn();
    const { container } = await mount(
      <PreviewStep {...props({ summary: summary({ missingProducerRows: 2 }), onConfirm })} />,
    );

    const checkbox = acknowledgeCheckbox(container)!;
    expect(checkbox.checked).toBe(false);
    await act(async () => checkbox.click());

    expect(confirmButton(container).disabled).toBe(false);
    await act(async () => confirmButton(container).click());
    expect(onConfirm).toHaveBeenCalledWith(2);
  });
});
