import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecentScan, ScanMode } from "@/lib/scanner/types";
import { ReadyView } from "./ready-view";

const recentScan: RecentScan = {
  id: "scan-1",
  parsedAt: "2026-08-20T12:00:00.000Z",
  distributor: "Test Distributor",
  items: 2,
  total: 50,
  accuracy: 95,
  hasImage: true,
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

describe("ReadyView", () => {
  it.each([
    ["invoice", "true", "false"],
    ["bottle", "false", "true"],
  ] as const)("exposes mutually exclusive pressed state in %s mode", async (mode, invoice, bottle) => {
    await renderReady(mode);

    expect(buttonNamed("Invoice").getAttribute("aria-pressed")).toBe(invoice);
    expect(buttonNamed("Bottle").getAttribute("aria-pressed")).toBe(bottle);
  });

  it("keeps bottle scanning inside the scan surface and delegates the mode change", async () => {
    const onModeChange = vi.fn();
    await renderReady("invoice", onModeChange);

    await act(async () => buttonNamed("Bottle").click());

    expect(onModeChange).toHaveBeenCalledWith("bottle");
    expect(container.querySelector('a[href="/scan-bottle"]')).toBeNull();
  });

  it("keeps every visible action at least 44px at desktop breakpoints", async () => {
    await renderReady("invoice", vi.fn(), true);

    for (const element of container.querySelectorAll<HTMLElement>("button, a")) {
      expect(element.className).not.toMatch(/(?:^|\s)md:h-\[(?:3[0-9]|4[0-3])px\]/);
      expect(element.className).toMatch(/(?:^|\s)(?:min-h-11|h-11|h-12)(?:\s|$)/);
    }
  });

  it("announces only the saved confirmation text, not the adjacent actions", async () => {
    await renderReady("invoice", vi.fn(), true);

    const status = container.querySelector<HTMLElement>('[role="status"]');
    expect(status?.textContent).toContain("Saved 2 items to inventory");
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.querySelector("a, button")).toBeNull();
    expect(status?.contains(linkNamed("Add to wine list"))).toBe(false);
    expect(status?.contains(buttonNamed("Dismiss"))).toBe(false);
  });
});

describe("ReadyView upload limits and selection (M0-1)", () => {
  it("advertises the real 10 MB invoice limit, not a mismatched 20 MB", async () => {
    await renderReady("invoice");
    expect(container.textContent).toContain("up to 10MB");
    expect(container.textContent).not.toContain("up to 20MB");
  });

  it("advertises 20 MB for bottle photos", async () => {
    await renderReady("bottle");
    expect(container.textContent).toContain("up to 20MB");
  });

  it("does not allow multi-selecting bottle photos — one label per scan", async () => {
    await renderReady("bottle");
    const uploadInput = getUploadInput();
    expect(uploadInput.multiple).toBe(false);
  });

  it("allows multi-selecting invoice files — a multi-page invoice is a real, supported batch", async () => {
    await renderReady("invoice");
    const uploadInput = getUploadInput();
    expect(uploadInput.multiple).toBe(true);
  });

  it("resets the file input value after a selection so re-selecting the same file fires change again", async () => {
    const onStart = vi.fn();
    await act(async () => {
      root.render(
        <ReadyView
          onStart={onStart}
          mode="invoice"
          onModeChange={() => {}}
          recentScans={[]}
          savedResult={null}
          onDismissSaved={() => {}}
        />,
      );
    });
    const input = getUploadInput();
    const file = new File(["invoice"], "invoice.jpg", { type: "image/jpeg" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    // jsdom doesn't simulate the browser populating `.value` from a fake
    // `files` override, so spy on the setter directly: this proves the
    // handler explicitly clears it (the real bug — some mobile browsers/
    // webviews won't fire `change` again for the same file otherwise).
    const setValue = vi.fn();
    Object.defineProperty(input, "value", { configurable: true, get: () => "", set: setValue });

    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));

    expect(onStart).toHaveBeenCalledWith([file]);
    expect(setValue).toHaveBeenCalledWith("");
  });
});

function getUploadInput(): HTMLInputElement {
  const inputs = [...container.querySelectorAll<HTMLInputElement>('input[type="file"]')];
  const input = inputs.at(-1);
  if (!input) throw new Error("Could not find upload file input");
  return input;
}

async function renderReady(
  mode: ScanMode,
  onModeChange = vi.fn(),
  withSavedResult = false,
) {
  await act(async () => {
    root.render(
      <ReadyView
        onStart={vi.fn()}
        mode={mode}
        onModeChange={onModeChange}
        recentScans={[recentScan]}
        savedResult={withSavedResult ? { itemCount: 2, wineCount: 2 } : null}
        onDismissSaved={vi.fn()}
      />,
    );
  });
}

function buttonNamed(name: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!button) throw new Error(`Could not find button named ${name}`);
  return button;
}

function linkNamed(name: string): HTMLAnchorElement {
  const link = [...container.querySelectorAll<HTMLAnchorElement>("a")].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!link) throw new Error(`Could not find link named ${name}`);
  return link;
}
