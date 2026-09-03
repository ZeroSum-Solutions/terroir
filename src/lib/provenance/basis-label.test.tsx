import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { BasisLabel } from "./basis-label";
import type { Basis } from "./sourced";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function render(basis: Basis) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<BasisLabel basis={basis} />);
  });
  return container;
}

describe("BasisLabel", () => {
  // Exhaustive on purpose. A sixth Basis kind arriving without a sentence
  // should be loud here rather than shipping a number with nothing under it.
  const cases: [string, Basis, RegExp][] = [
    ["house", { kind: "house", notes: 14 }, /across 14 house notes/i],
    ["house with one note", { kind: "house", notes: 1 }, /across 1 house note(?!s)/i],
    [
      "sourced",
      { kind: "sourced", name: "Domaine Leflaive", url: "https://example.invalid/sheet", asOf: "2026-08-14" },
      /Domaine Leflaive/,
    ],
    ["corpus", { kind: "corpus", name: "X-Wines" }, /X-Wines reference corpus/],
    ["override", { kind: "override", by: "Devin", at: "2026-07-02" }, /set by the house/i],
    ["measured", { kind: "measured", asOf: "2026-09-01" }, /your own records/i],
  ];

  it.each(cases)("renders a sentence for a %s basis", async (_name, basis, pattern) => {
    const el = await render(basis);
    expect(el.textContent).toMatch(pattern);
  });

  it("dates a sourced basis, so a stale sheet reads as stale", async () => {
    const el = await render({
      kind: "sourced", name: "Domaine Leflaive",
      url: "https://example.invalid/sheet", asOf: "2026-08-14",
    });
    expect(el.textContent).toMatch(/14 August 2026/);
  });

  it("links a sourced basis to the thing it came from", async () => {
    const el = await render({
      kind: "sourced", name: "Domaine Leflaive",
      url: "https://example.invalid/sheet", asOf: "2026-08-14",
    });
    const link = el.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.invalid/sheet");
  });

  it("names the person behind an override", async () => {
    const el = await render({ kind: "override", by: "Devin", at: "2026-07-02" });
    expect(el.textContent).toMatch(/Devin/);
    expect(el.textContent).toMatch(/2 July 2026/);
  });

  it("does not link anything that has no source to link to", async () => {
    const el = await render({ kind: "house", notes: 3 });
    expect(el.querySelector("a")).toBeNull();
  });

  it("falls back to the raw string rather than rendering Invalid Date", async () => {
    const el = await render({ kind: "measured", asOf: "not-a-date" });
    expect(el.textContent).toMatch(/not-a-date/);
    expect(el.textContent).not.toMatch(/Invalid Date/);
  });
});
