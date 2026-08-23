import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BottleCandidate, BottleScanResult } from "@/lib/scanner/types";
import { BottleResultsView } from "./bottle-results-view";

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

function candidate(overrides: Partial<BottleCandidate> = {}): BottleCandidate {
  return {
    name: "Volnay 1er Cru",
    producer: "Domaine Test",
    vintage: 2021,
    varietal: "Pinot Noir",
    region: "Burgundy",
    country: "France",
    format: "750ml",
    confidence: 0.95,
    lowFields: [],
    notes: null,
    ...overrides,
  };
}

function makeResult(candidates: BottleCandidate[]): BottleScanResult {
  return { candidates, parsedAt: "2026-08-20T12:00:00.000Z" };
}

async function renderView(props: Partial<Parameters<typeof BottleResultsView>[0]> = {}) {
  const onSave = props.onSave ?? vi.fn();
  const onScanAnother = props.onScanAnother ?? vi.fn();
  await act(async () => {
    root.render(
      <BottleResultsView
        result={props.result ?? makeResult([candidate()])}
        onSave={onSave}
        onScanAnother={onScanAnother}
        isSaving={props.isSaving ?? false}
      />,
    );
  });
  return { onSave, onScanAnother };
}

function buttonNamed(name: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.trim().includes(name),
  );
  if (!button) throw new Error(`Could not find button containing "${name}"`);
  return button;
}

describe("BottleResultsView — confidence display", () => {
  it("shows the overall confidence honestly labeled as an AI match, never as accuracy", async () => {
    await renderView({ result: makeResult([candidate({ confidence: 0.95 })]) });

    expect(container.textContent).toContain("AI match confidence");
    expect(container.textContent).toContain("95%");
    expect(container.textContent).not.toMatch(/accuracy/i);
  });

  it("shows a low-confidence banner without overclaiming when confidence is low", async () => {
    await renderView({ result: makeResult([candidate({ confidence: 0.55 })]) });

    expect(container.textContent).toContain("Low AI match confidence (55%)");
    expect(container.textContent).not.toMatch(/accuracy/i);
  });

  it("does not show the low-confidence banner for a confident match", async () => {
    await renderView({ result: makeResult([candidate({ confidence: 0.95 })]) });

    expect(container.textContent).not.toContain("Low AI match confidence");
  });
});

describe("BottleResultsView — per-field low-confidence flags", () => {
  it("visibly flags identity fields the model listed as low-confidence", async () => {
    await renderView({
      result: makeResult([
        candidate({ confidence: 0.6, lowFields: ["vintage", "format"] }),
      ]),
    });

    const flags = [...container.querySelectorAll("*")].filter(
      (el) => el.textContent?.trim() === "Needs review",
    );
    // Exactly the two flagged fields get a "Needs review" badge — not more, not fewer.
    expect(flags).toHaveLength(2);
  });

  it("does not flag fields absent from lowFields", async () => {
    await renderView({
      result: makeResult([candidate({ confidence: 0.6, lowFields: ["vintage"] })]),
    });

    // Producer's label IS shown (unflagged); only the one flagged field
    // (vintage) should carry a "Needs review" badge.
    expect(container.textContent).toContain("Producer");
    const flags = [...container.querySelectorAll("*")].filter(
      (el) => el.textContent?.trim() === "Needs review",
    );
    expect(flags).toHaveLength(1);
  });
});

describe("BottleResultsView — alternatives", () => {
  it("shows alternative candidates when the model returned more than one", async () => {
    await renderView({
      result: makeResult([
        candidate({ name: "Volnay 1er Cru", confidence: 0.6 }),
        candidate({ name: "Volnay Villages", confidence: 0.4 }),
      ]),
    });

    expect(container.textContent).toContain("Other possible matches");
    expect(container.textContent).toContain("Volnay 1er Cru");
    expect(container.textContent).toContain("Volnay Villages");
  });

  it("does not show an alternatives section for a single candidate", async () => {
    await renderView({ result: makeResult([candidate()]) });

    expect(container.textContent).not.toContain("Other possible matches");
  });

  it("switches the displayed candidate when an alternative is selected", async () => {
    await renderView({
      result: makeResult([
        candidate({ name: "Volnay 1er Cru", producer: "Domaine A", confidence: 0.6 }),
        candidate({ name: "Volnay Villages", producer: "Domaine B", confidence: 0.4 }),
      ]),
    });

    expect(container.textContent).toContain("Domaine A");
    await act(async () => buttonNamed("Volnay Villages").click());
    expect(container.textContent).toContain("Domaine B");
  });
});

describe("BottleResultsView — confirm-or-correct gate", () => {
  it("does not call onSave merely by rendering the result", async () => {
    const { onSave } = await renderView();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("Confirm commits the AI candidate's fields immediately, with no edits required", async () => {
    const { onSave } = await renderView({
      result: makeResult([
        candidate({
          name: "Volnay 1er Cru",
          producer: "Domaine Test",
          vintage: 2021,
          region: "Burgundy",
          format: "750ml",
        }),
      ]),
    });

    await act(async () => buttonNamed("Confirm & save").click());

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Volnay 1er Cru",
        producer: "Domaine Test",
        vintage: 2021,
        region: "Burgundy",
        format: "750ml",
        qty: 1,
        unitCost: 0,
      }),
    );
  });

  it("Correct details reveals inline editable fields without committing anything", async () => {
    const { onSave } = await renderView();

    await act(async () => buttonNamed("correct details").click());

    expect(onSave).not.toHaveBeenCalled();
    // The primary action relabels to the corrected-save flow.
    expect(container.textContent).toContain("Save to inventory");
    expect(container.textContent).not.toContain("Confirm & save");
    // Editable inputs now exist for the identity fields.
    const nameInput = container.querySelector('input[aria-label="Wine name"]') as HTMLInputElement | null;
    expect(nameInput?.value).toBe("Volnay 1er Cru");
  });

  it("saves the corrected fields (not the original AI output) after editing", async () => {
    const { onSave } = await renderView({
      result: makeResult([candidate({ name: "Volnay 1er Cru" })]),
    });

    await act(async () => buttonNamed("correct details").click());

    const nameInput = container.querySelector('input[aria-label="Wine name"]') as HTMLInputElement;
    const nativeValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      nativeValueSetter.call(nameInput, "Volnay Clos des Chênes");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // React's onBlur is wired to the (bubbling) native "focusout" event, not
    // "blur" (which doesn't bubble) — see field-inputs.test.tsx's `blur()`.
    await act(async () => {
      nameInput.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });

    await act(async () => buttonNamed("Save to inventory").click());

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Volnay Clos des Chênes" }),
    );
  });

  it("hides the alternatives selector once the user has started correcting details", async () => {
    await renderView({
      result: makeResult([
        candidate({ name: "Volnay 1er Cru", confidence: 0.6 }),
        candidate({ name: "Volnay Villages", confidence: 0.4 }),
      ]),
    });

    await act(async () => buttonNamed("correct details").click());

    expect(container.textContent).not.toContain("Other possible matches");
  });
});

describe("BottleResultsView — user-provided fields", () => {
  it("always allows quantity/unit cost input regardless of confirm-or-correct stage", async () => {
    await renderView();
    expect(container.textContent).toContain("You provide");
    expect(container.textContent).toContain("Quantity");
    expect(container.textContent).toContain("Unit cost");
  });
});
