import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecentScan, ScanMode } from "@/lib/scanner/types";
import { pageHasItsOwnSearch } from "@/app/(app)/search/search-palette";
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
          onSpreadsheet={vi.fn()}
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

function renderWithSpreadsheetHandler(
  onStart: (files: File[]) => void,
  onSpreadsheet: (file: File) => void,
) {
  return act(async () => {
    root.render(
      <ReadyView
        onStart={onStart}
        onSpreadsheet={onSpreadsheet}
        mode="invoice"
        onModeChange={() => {}}
        recentScans={[]}
        savedResult={null}
        onDismissSaved={() => {}}
      />,
    );
  });
}

async function selectFile(file: File) {
  const input = getUploadInput();
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  Object.defineProperty(input, "value", { configurable: true, get: () => "", set: () => {} });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
}

describe("ReadyView — spreadsheets belong to Import, not the scanner", () => {
  it("hands a .csv to the import handler instead of starting a scan", async () => {
    const onStart = vi.fn();
    const onSpreadsheet = vi.fn();
    await renderWithSpreadsheetHandler(onStart, onSpreadsheet);

    const file = new File(["producer,wine"], "cellar.csv", { type: "text/csv" });
    await selectFile(file);

    expect(onSpreadsheet).toHaveBeenCalledWith(file);
    // Starting a scan on a spreadsheet could only fail: document intelligence
    // reads photos and PDFs.
    expect(onStart).not.toHaveBeenCalled();
  });

  it("hands a .xlsx to the import handler instead of starting a scan", async () => {
    const onStart = vi.fn();
    const onSpreadsheet = vi.fn();
    await renderWithSpreadsheetHandler(onStart, onSpreadsheet);

    const file = new File(["PK"], "cellar.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    await selectFile(file);

    expect(onSpreadsheet).toHaveBeenCalledWith(file);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("still scans an ordinary invoice image", async () => {
    const onStart = vi.fn();
    const onSpreadsheet = vi.fn();
    await renderWithSpreadsheetHandler(onStart, onSpreadsheet);

    const file = new File(["invoice"], "invoice.jpg", { type: "image/jpeg" });
    await selectFile(file);

    expect(onStart).toHaveBeenCalledWith([file]);
    expect(onSpreadsheet).not.toHaveBeenCalled();
  });

  it("offers spreadsheets in the invoice file picker", async () => {
    await renderWithSpreadsheetHandler(vi.fn(), vi.fn());
    const accept = getUploadInput().getAttribute("accept") ?? "";
    expect(accept).toContain(".csv");
    expect(accept).toContain(".xlsx");
  });
});

function fileEvent(type: string, files: File[]) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const transfer = {
    items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
    files,
    types: ["Files"],
    dropEffect: "none",
  };
  Object.defineProperty(event, type === "paste" ? "clipboardData" : "dataTransfer", { value: transfer });
  return event;
}

describe("ReadyView — dropping and pasting reach the same route as the picker", () => {
  it("scans a file dropped anywhere on the window", async () => {
    const onStart = vi.fn();
    await renderWithSpreadsheetHandler(onStart, vi.fn());

    const file = new File(["invoice"], "invoice.jpg", { type: "image/jpeg" });
    await act(async () => window.dispatchEvent(fileEvent("drop", [file])));

    expect(onStart).toHaveBeenCalledWith([file]);
  });

  it("keeps every page of a multi-page invoice dropped together", async () => {
    const onStart = vi.fn();
    await renderWithSpreadsheetHandler(onStart, vi.fn());

    const one = new File(["1"], "page-1.jpg", { type: "image/jpeg" });
    const two = new File(["2"], "page-2.jpg", { type: "image/jpeg" });
    await act(async () => window.dispatchEvent(fileEvent("drop", [one, two])));

    expect(onStart).toHaveBeenCalledWith([one, two]);
  });

  it("sends a dropped spreadsheet to Import, exactly as the picker does", async () => {
    const onStart = vi.fn();
    const onSpreadsheet = vi.fn();
    await renderWithSpreadsheetHandler(onStart, onSpreadsheet);

    const file = new File(["producer,wine"], "cellar.csv", { type: "text/csv" });
    await act(async () => window.dispatchEvent(fileEvent("drop", [file])));

    expect(onSpreadsheet).toHaveBeenCalledWith(file);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("scans a pasted screenshot, giving it a name of its own", async () => {
    const onStart = vi.fn();
    await renderWithSpreadsheetHandler(onStart, vi.fn());

    const pasted = new File(["png"], "image.png", { type: "image/png" });
    await act(async () => window.dispatchEvent(fileEvent("paste", [pasted])));

    expect(onStart).toHaveBeenCalledTimes(1);
    const [files] = onStart.mock.calls[0] as [File[]];
    expect(files[0].name).toMatch(/^pasted-\d{4}-\d{2}-\d{2}-\d{4}\.png$/);
  });

  it("leaves no capture-latency mark for a dropped file, which waited on no dialog", async () => {
    performance.clearMarks?.("terroir:scan:capture:end");
    await renderWithSpreadsheetHandler(vi.fn(), vi.fn());

    await act(async () =>
      window.dispatchEvent(fileEvent("drop", [new File(["i"], "invoice.jpg", { type: "image/jpeg" })])),
    );

    // The capture stage measures tap-to-file-selected. A drop skips the dialog
    // entirely, so marking it would report a wait that never happened — and a
    // stale end mark would go on to corrupt the NEXT picked file's measurement.
    expect(performance.getEntriesByName("terroir:scan:capture:end")).toHaveLength(0);
  });

  it("still marks capture for a file chosen through the dialog", async () => {
    performance.clearMarks?.("terroir:scan:capture:end");
    await renderWithSpreadsheetHandler(vi.fn(), vi.fn());

    await selectFile(new File(["i"], "invoice.jpg", { type: "image/jpeg" }));

    expect(performance.getEntriesByName("terroir:scan:capture:end").length).toBeGreaterThan(0);
    performance.clearMarks?.("terroir:scan:capture:end");
  });

  it("prevents the browser navigating away from a drop, which would lose the screen", async () => {
    await renderWithSpreadsheetHandler(vi.fn(), vi.fn());

    const event = fileEvent("drop", [new File(["i"], "invoice.jpg", { type: "image/jpeg" })]);
    await act(async () => window.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(true);
  });

  it("offers a Paste button where the browser can be asked for the clipboard", async () => {
    await renderWithSpreadsheetHandler(vi.fn(), vi.fn());

    expect(buttonNamed("Paste")).toBeTruthy();
  });

  it("hides the Paste button on a browser that cannot be asked", async () => {
    // An older browser reaches the page with no clipboard read at all; a button
    // that could only ever fail is worse than no button.
    vi.stubGlobal("navigator", {});
    await renderWithSpreadsheetHandler(vi.fn(), vi.fn());

    expect(
      [...container.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Paste"),
    ).toBe(false);
    vi.unstubAllGlobals();
  });

  it("scans what the Paste button reads from the clipboard", async () => {
    const blob = new Blob(["png"], { type: "image/png" });
    vi.stubGlobal("navigator", {
      clipboard: { read: async () => [{ types: ["image/png"], getType: async () => blob }] },
    });
    const onStart = vi.fn();
    await renderWithSpreadsheetHandler(onStart, vi.fn());

    await act(async () => buttonNamed("Paste").click());

    expect(onStart).toHaveBeenCalledTimes(1);
    const [files] = onStart.mock.calls[0] as [File[]];
    expect(files[0].type).toBe("image/png");
    vi.unstubAllGlobals();
  });

  it("says so rather than failing silently when the clipboard holds no image", async () => {
    vi.stubGlobal("navigator", { clipboard: { read: async () => [] } });
    const onStart = vi.fn();
    await renderWithSpreadsheetHandler(onStart, vi.fn());

    await act(async () => buttonNamed("Paste").click());

    expect(container.textContent).toContain("No image on the clipboard");
    expect(onStart).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("says so when the browser refuses to share the clipboard", async () => {
    vi.stubGlobal("navigator", {
      clipboard: {
        read: async () => {
          throw new DOMException("denied", "NotAllowedError");
        },
      },
    });
    await renderWithSpreadsheetHandler(vi.fn(), vi.fn());

    await act(async () => buttonNamed("Paste").click());

    expect(container.textContent).toContain("Allow paste when your browser asks");
    vi.unstubAllGlobals();
  });
});

describe("ReadyView — search belongs to the global palette (P1 slice 2c)", () => {
  it("declares no route-local search, so the palette's / shortcut serves /scan", async () => {
    await renderReady("invoice");
    // The exact probe the palette's "/" handler runs: with the scan search
    // panel gone, "/" on /scan must reach the global palette.
    expect(pageHasItsOwnSearch()).toBe(false);
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
        onSpreadsheet={vi.fn()}
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
