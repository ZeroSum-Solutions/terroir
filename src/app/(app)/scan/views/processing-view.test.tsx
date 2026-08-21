import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProcessingView,
  stageForProgress,
  type ScanStage,
} from "./processing-view";
import type { ScanMode } from "@/lib/scanner/types";

let container: HTMLDivElement;
let root: Root;

const stageCases: Array<{
  mode: ScanMode;
  expected: ReadonlyArray<readonly [number, ScanStage]>;
}> = [
  {
    mode: "invoice",
    expected: [
      [0, "upload"],
      [29, "upload"],
      [30, "extract"],
      [69, "extract"],
      [70, "review"],
      [95, "review"],
    ],
  },
  {
    mode: "bottle",
    expected: [
      [0, "upload"],
      [29, "upload"],
      [30, "identify"],
      [69, "identify"],
      [70, "review"],
      [95, "review"],
    ],
  },
];

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe.each(stageCases)("$mode stage derivation", ({ mode, expected }) => {
  it.each(expected)("maps %i percent to %s", (progress, stage) => {
    expect(stageForProgress(mode, progress)).toBe(stage);
  });
});

describe("ProcessingView", () => {
  it("announces the supplied invoice stage with estimated progress semantics", async () => {
    const onCancel = vi.fn();
    await renderProcessing({
      progress: 45,
      stage: "extract",
      mode: "invoice",
      onCancel,
    });

    const progressbar = container.querySelector('[role="progressbar"]');
    expect(progressbar?.getAttribute("aria-valuemin")).toBe("0");
    expect(progressbar?.getAttribute("aria-valuemax")).toBe("100");
    expect(progressbar?.getAttribute("aria-valuenow")).toBe("45");
    expect(progressbar?.getAttribute("aria-valuetext")).toBe(
      "Extracting invoice details, estimated 45% complete",
    );

    const activeStep = container.querySelector('[aria-current="step"]');
    expect(activeStep?.textContent).toContain("Extracting invoice details");
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toContain(
      "Extracting invoice details",
    );
    expect(container.textContent).toContain("Estimated progress");

    const cancel = buttonNamed("Cancel scan");
    expect(cancel.className).toContain("h-11");
    await act(async () => cancel.click());
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toMatch(/Claude|Sonnet|OpenAI/i);
  });

  it("uses its supplied stage instead of deriving a second stage from progress", async () => {
    await renderProcessing({
      progress: 45,
      stage: "review",
      mode: "invoice",
      onCancel: vi.fn(),
    });

    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain(
      "Preparing your review",
    );
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuetext")).toBe(
      "Preparing your review, estimated 45% complete",
    );
  });

  it("uses bottle-specific stage labels without provider terminology", async () => {
    await renderProcessing({
      progress: 45,
      stage: "identify",
      mode: "bottle",
      onCancel: vi.fn(),
    });

    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain(
      "Identifying the wine",
    );
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuetext")).toBe(
      "Identifying the wine, estimated 45% complete",
    );
    expect(container.textContent).not.toMatch(/Claude|Sonnet|OpenAI/i);
  });
});

async function renderProcessing(props: {
  progress: number;
  stage: ScanStage;
  mode: ScanMode;
  onCancel: () => void;
}) {
  await act(async () => root.render(<ProcessingView {...props} />));
}

function buttonNamed(name: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!button) throw new Error(`Could not find button named ${name}`);
  return button;
}
