import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ML_PER_OZ } from "@/lib/units";
import type { OpenBottleRow } from "@/lib/wine-list/shapes";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const { ReconcileList } = await import("./reconcile-list");

const item: OpenBottleRow = {
  wine_id: "wine-1",
  wine_list_item_id: "item-1",
  producer: "Test Producer",
  name: "Test Wine",
  vintage: 2022,
  size_ml: 750,
  sealed_count: 0,
  opened_at: "2026-08-20T12:00:00.000Z",
  open_remaining_ml: 110,
  glass_pour_ml: 148,
  pour_size_mode: "fixed",
};

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

describe("ReconcileList variance presentation", () => {
  it("keeps reconciliation form controls at least 44px tall", async () => {
    await act(async () => root.render(<ReconcileList initialItems={[item]} />));
    const actual = container.querySelector<HTMLInputElement>(
      'input[aria-label="Actual remaining volume in ml"]',
    )!;
    const note = container.querySelector<HTMLInputElement>(
      'input[placeholder="spill, miscount, etc."]',
    )!;

    expect(actual.className).toContain("h-11");
    expect(note.className).toContain("h-11");
  });

  it.each([
    {
      name: "subthreshold over",
      expected: 110,
      actual: 130,
      copy: varianceCopy(20, "over expected"),
      badgeTone: "bg-ready-wash",
      cardClasses: ["card-surface"],
    },
    {
      name: "subthreshold under",
      expected: 110,
      actual: 90,
      copy: varianceCopy(-20, "under expected"),
      badgeTone: "bg-risk-wash",
      cardClasses: ["card-surface"],
    },
    {
      name: "exact",
      expected: 110,
      actual: 110,
      copy: varianceCopy(0, "exact"),
      badgeTone: "bg-wash",
      cardClasses: ["card-surface"],
    },
    {
      name: "zero expected without a flagged card",
      expected: 0,
      actual: 20,
      copy: varianceCopy(20, "over expected"),
      badgeTone: "bg-ready-wash",
      cardClasses: ["card-surface"],
    },
    {
      name: "flagged over",
      expected: 110,
      actual: 170,
      copy: varianceCopy(60, "over expected"),
      badgeTone: "bg-ready-wash",
      cardClasses: ["border-ready-ink/30", "bg-ready-wash"],
    },
    {
      name: "flagged under",
      expected: 110,
      actual: 50,
      copy: varianceCopy(-60, "under expected"),
      badgeTone: "bg-risk-wash",
      cardClasses: ["border-risk-ink/40", "bg-risk-wash"],
    },
  ])("renders $name truthfully", async ({ expected, actual, copy, badgeTone, cardClasses }) => {
    const fixture = { ...item, open_remaining_ml: expected };
    await act(async () => root.render(<ReconcileList initialItems={[fixture]} />));
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Actual remaining volume in ml"]',
    )!;
    // Enter a distinct value first so exact state has pending input to present.
    if (actual === expected) setInputValue(input, expected + 1);
    setInputValue(input, actual);
    const badge = findElementByText(container, copy);
    expect(badge.className).toContain(badgeTone);
    const card = badge.closest("li")!;
    for (const className of cardClasses) expect(card.className).toContain(className);
  });
});

function setInputValue(input: HTMLInputElement, value: number) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setValue) throw new Error("Native input value setter is unavailable");
  act(() => {
    setValue.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function findElementByText(container: HTMLElement, copy: RegExp): HTMLElement {
  const match = [...container.querySelectorAll<HTMLElement>("*")].find(
    (element) =>
      copy.test(element.textContent ?? "") &&
      ![...element.children].some((child) => copy.test(child.textContent ?? "")),
  );
  if (!match) throw new Error(`Could not find element matching ${copy}`);
  return match;
}

function varianceCopy(deltaMl: number, label: string): RegExp {
  const sign = deltaMl > 0 ? "\\+" : deltaMl < 0 ? "−" : "";
  const ounces = Math.abs(deltaMl / ML_PER_OZ).toFixed(1);
  return new RegExp(`${sign}${ounces} oz · ${label}`, "i");
}
