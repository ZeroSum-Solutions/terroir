import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BottleScanResult, Scan } from "@/lib/scanner/types";

vi.mock("@/lib/context/restaurant", () => ({
  useRestaurant: () => ({ restaurantId: "restaurant-1" }),
}));

const csvMocks = vi.hoisted(() => ({ downloadCsv: vi.fn() }));
const processingRenderHistory = vi.hoisted(() => ({
  renders: [] as Array<{ progress: number; stage: string; mode: string }>,
}));

vi.mock("@/lib/scanner/csv", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/scanner/csv")>();
  return { ...actual, downloadCsv: csvMocks.downloadCsv };
});

vi.mock("./views/processing-view", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./views/processing-view")>();
  return {
    ...actual,
    ProcessingView: (props: Parameters<typeof actual.ProcessingView>[0]) => {
      processingRenderHistory.renders.push({
        progress: props.progress,
        stage: props.stage,
        mode: props.mode,
      });
      return actual.ProcessingView(props);
    },
  };
});

const { Scanner } = await import("./scanner");
const { stageForProgress } = await import("./views/processing-view");

const invoiceResult: Scan = {
  source: {
    distributor: "Test Distributor",
    invoiceNo: "INV-1",
    invoiceDate: "2026-08-20",
    parsedAt: "2026-08-20T12:00:00.000Z",
  },
  items: [
    {
      id: "item-1",
      name: "Test Wine",
      producer: "Test Producer",
      vintage: 2022,
      varietal: "Pinot Noir",
      region: "Willamette Valley",
      qty: 1,
      unitCost: 24,
      currency: "USD",
      format: "750ml",
      confidence: 0.95,
    },
  ],
  edits: {},
  quality: {
    avgConfidence: 0.95,
    lowConfidenceItems: 0,
    totalItems: 1,
    manualFallbackTriggered: false,
  },
};

const bottleResult: BottleScanResult = {
  name: "Test Pinot Noir",
  producer: "Test Producer",
  vintage: 2022,
  varietal: "Pinot Noir",
  region: "Willamette Valley",
  country: "United States",
  confidence: 0.95,
  notes: null,
  parsedAt: "2026-08-20T12:00:00.000Z",
};

let container: HTMLDivElement;
let root: Root | null;

beforeEach(async () => {
  processingRenderHistory.renders.length = 0;
  csvMocks.downloadCsv.mockReset();
  csvMocks.downloadCsv.mockImplementation(() => undefined);
  vi.stubGlobal("Storage", MemoryStorage);
  vi.stubGlobal("localStorage", new MemoryStorage());
  localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(<Scanner />));
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Scanner cancellation lifecycle", () => {
  it("aborts an invoice request and returns to ready without an error", async () => {
    const request = deferred<Response>();
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return request.promise;
    }));

    await selectReadyFile(new File(["invoice"], "invoice.jpg", { type: "image/jpeg" }));
    expect(container.textContent).toContain("Uploading invoice");
    await clickButton("Cancel scan");

    expect(signal?.aborted).toBe(true);
    expect(container.textContent).toContain("Scan an invoice");
    expect(container.textContent).not.toContain("Couldn’t read");
  });

  it("aborts a bottle request and returns to the bottle-ready state", async () => {
    const request = deferred<Response>();
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return request.promise;
    }));

    await clickButton("Bottle");
    await selectReadyFile(new File(["label"], "label.jpg", { type: "image/jpeg" }));
    await clickButton("Cancel scan");

    expect(signal?.aborted).toBe(true);
    expect(container.textContent).toContain("Scan a bottle label");
    expect(container.textContent).not.toContain("Couldn’t read");
  });

  it("aborts the active request when Scanner unmounts", async () => {
    const request = deferred<Response>();
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return request.promise;
    }));

    await selectReadyFile(new File(["invoice"], "invoice.jpg", { type: "image/jpeg" }));
    await act(async () => root?.unmount());
    root = null;

    expect(signal?.aborted).toBe(true);
  });

  it("does not remove a persisted result as a side effect of cancelling", async () => {
    const request = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => request.promise));
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");

    await selectReadyFile(new File(["invoice"], "invoice.jpg", { type: "image/jpeg" }));
    removeItem.mockClear();
    await clickButton("Cancel scan");

    expect(removeItem).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Scan an invoice");
  });

  it("mints a fresh invoice idempotency key after a cancelled attempt", async () => {
    const requests: Array<{ url: string; key: string; signal: AbortSignal }> = [];
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      requests.push({
        url: String(url),
        key: headers["Idempotency-Key"],
        signal: init?.signal as AbortSignal,
      });
      return deferred<Response>().promise;
    }));

    await selectReadyFile(new File(["first"], "first.jpg", { type: "image/jpeg" }));
    await clickButton("Cancel scan");
    await selectReadyFile(new File(["second"], "second.jpg", { type: "image/jpeg" }));

    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.url)).toEqual(["/api/scan", "/api/scan"]);
    expect(requests[0].key).toBeTruthy();
    expect(requests[1].key).toBeTruthy();
    expect(requests[1].key).not.toBe(requests[0].key);
  });

  it("ignores a bottle result decoded after cancellation", async () => {
    const json = deferred<BottleScanResult>();
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return Promise.resolve(responseWithJson(json.promise));
    }));

    await clickButton("Bottle");
    await selectReadyFile(new File(["label"], "label.jpg", { type: "image/jpeg" }));
    await clickButton("Cancel scan");
    expect(signal?.aborted).toBe(true);
    expect(container.textContent).toContain("Scan a bottle label");

    await act(async () => {
      json.resolve(bottleResult);
      await json.promise;
    });

    expect(container.textContent).toContain("Scan a bottle label");
    expect(container.textContent).not.toContain("Wine identified");
  });

  it("ignores a successful invoice result decoded after cancellation", async () => {
    const json = deferred<Scan>();
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return Promise.resolve(responseWithJson(json.promise));
    }));
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    await selectReadyFile(new File(["invoice"], "invoice.jpg", { type: "image/jpeg" }));
    await clickButton("Cancel scan");
    expect(signal?.aborted).toBe(true);
    setItem.mockClear();

    await act(async () => {
      json.resolve(invoiceResult);
      await json.promise;
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Scan an invoice");
    expect(container.textContent).not.toContain("Invoice scan results");
    expect(setItem).not.toHaveBeenCalled();
  });

  it("ignores an AbortError rejected after invoice cancellation", async () => {
    const request = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => request.promise));

    await selectReadyFile(new File(["invoice"], "invoice.jpg", { type: "image/jpeg" }));
    await clickButton("Cancel scan");

    await act(async () => {
      request.reject(new DOMException("The operation was aborted", "AbortError"));
      await request.promise.catch(() => undefined);
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Scan an invoice");
    expect(container.textContent).not.toContain("Couldn’t read");
  });

  it("ignores an AbortError rejected after bottle cancellation", async () => {
    const request = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => request.promise));

    await clickButton("Bottle");
    await selectReadyFile(new File(["label"], "label.jpg", { type: "image/jpeg" }));
    await clickButton("Cancel scan");

    await act(async () => {
      request.reject(new DOMException("The operation was aborted", "AbortError"));
      await request.promise.catch(() => undefined);
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Scan a bottle label");
    expect(container.textContent).not.toContain("Couldn’t read the label");
  });

  it("keeps the replacement controller cancellable when the first request settles late", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal as AbortSignal);
      return signals.length === 1 ? first.promise : second.promise;
    }));

    await selectReadyFile(new File(["first"], "first.jpg", { type: "image/jpeg" }));
    await clickButton("Cancel scan");
    await selectReadyFile(new File(["second"], "second.jpg", { type: "image/jpeg" }));

    await act(async () => {
      first.resolve(responseWithJson(Promise.resolve(invoiceResult)));
      await first.promise;
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Uploading invoice");
    expect(signals[1].aborted).toBe(false);

    await clickButton("Cancel scan");
    expect(signals[1].aborted).toBe(true);
    expect(container.textContent).toContain("Scan an invoice");
  });

  it("allows a replacement invoice request to complete after the first settles late", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetchMock = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    vi.stubGlobal("fetch", fetchMock);

    await selectReadyFile(new File(["first"], "first.jpg", { type: "image/jpeg" }));
    await clickButton("Cancel scan");
    await selectReadyFile(new File(["second"], "second.jpg", { type: "image/jpeg" }));

    await act(async () => {
      first.resolve(responseWithJson(Promise.resolve(invoiceResult)));
      await first.promise;
      await Promise.resolve();
      second.resolve(responseWithJson(Promise.resolve(invoiceResult)));
      await second.promise;
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Invoice scan results");
    expect(container.textContent).not.toContain("Couldn’t read");
  });
});

describe("Scanner progress reset", () => {
  it("starts a second invoice attempt at upload and zero estimated progress", async () => {
    const second = deferred<Response>();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(responseWithJson(Promise.resolve(invoiceResult)))
      .mockReturnValueOnce(second.promise);
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(window, "confirm", {
      configurable: true,
      value: vi.fn(() => true),
    });

    await selectReadyFile(new File(["first"], "first.jpg", { type: "image/jpeg" }));
    expect(container.textContent).toContain("Invoice scan results");
    await clickButton("Clear");
    await clickButton("Discard scan");
    processingRenderHistory.renders.length = 0;
    await selectReadyFile(new File(["second"], "second.jpg", { type: "image/jpeg" }));

    expect(processingRenderHistory.renders[0]).toEqual({
      progress: 0,
      stage: stageForProgress("invoice", 0),
      mode: "invoice",
    });
    expect(processingRenderHistory.renders).not.toContainEqual(
      expect.objectContaining({ progress: 100, stage: "review" }),
    );
    expect(progressbar().getAttribute("aria-valuenow")).toBe("0");
    expect(progressbar().getAttribute("aria-valuetext")).toBe(
      "Uploading invoice, estimated 0% complete",
    );
  });

  it("starts a second bottle attempt at upload and zero estimated progress", async () => {
    const second = deferred<Response>();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(responseWithJson(Promise.resolve(bottleResult)))
      .mockReturnValueOnce(second.promise);
    vi.stubGlobal("fetch", fetchMock);

    await clickButton("Bottle");
    await selectReadyFile(new File(["first"], "first.jpg", { type: "image/jpeg" }));
    expect(container.textContent).toContain("Wine identified");
    await clickButton("Scan another");
    processingRenderHistory.renders.length = 0;
    await selectReadyFile(new File(["second"], "second.jpg", { type: "image/jpeg" }));

    expect(processingRenderHistory.renders[0]).toEqual({
      progress: 0,
      stage: stageForProgress("bottle", 0),
      mode: "bottle",
    });
    expect(processingRenderHistory.renders).not.toContainEqual(
      expect.objectContaining({ progress: 100, stage: "review" }),
    );
    expect(progressbar().getAttribute("aria-valuenow")).toBe("0");
    expect(progressbar().getAttribute("aria-valuetext")).toBe(
      "Uploading label photo, estimated 0% complete",
    );
  });
});

describe("Scanner mode-specific retry", () => {
  it("retries an invoice failure only through the invoice endpoint", async () => {
    const retry = deferred<Response>();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("invoice unavailable"))
      .mockReturnValueOnce(retry.promise);
    vi.stubGlobal("fetch", fetchMock);

    await selectReadyFile(new File(["invoice"], "invoice.jpg", { type: "image/jpeg" }));
    expect(container.textContent).toContain("Couldn’t read the invoice");
    fetchMock.mockClear();
    await clickButton("Retry invoice scan");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/scan");
  });

  it("retries a bottle failure only through the bottle endpoint", async () => {
    const retry = deferred<Response>();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("label unavailable"))
      .mockReturnValueOnce(retry.promise);
    vi.stubGlobal("fetch", fetchMock);

    await clickButton("Bottle");
    await selectReadyFile(new File(["label"], "label.jpg", { type: "image/jpeg" }));
    expect(container.textContent).toContain("Couldn’t read the label");
    fetchMock.mockClear();
    await clickButton("Retry label scan");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/scan-bottle");
    expect(fetchMock.mock.calls.some((call) => call[0] === "/api/scan")).toBe(false);
  });
});

describe("Scanner save and export feedback", () => {
  it("announces an invoice save failure with alert semantics", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(responseWithJson(Promise.resolve(invoiceResult)))
      .mockRejectedValueOnce(new Error("save blocked"));
    vi.stubGlobal("fetch", fetchMock);

    await selectReadyFile(new File(["invoice"], "invoice.jpg", { type: "image/jpeg" }));
    await clickButton("Save to Inventory");

    const alert = findRegion("alert", "save blocked");
    expect(alert.querySelector('svg[class*="triangle-alert"]')?.getAttribute("aria-hidden")).toBe("true");
  });

  it("announces a CSV export failure without reporting success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(
      responseWithJson(Promise.resolve(invoiceResult)),
    ));
    csvMocks.downloadCsv.mockImplementation(() => {
      throw new Error("export blocked");
    });

    await selectReadyFile(new File(["invoice"], "invoice.jpg", { type: "image/jpeg" }));
    await clickButtonByTitle("Export as CSV");

    const alert = findRegion("alert", "export blocked");
    expect(alert.querySelector('svg[class*="triangle-alert"]')?.getAttribute("aria-hidden")).toBe("true");
    expect(container.textContent).not.toContain("Exported 1 wine");
  });

  it("announces a successful CSV export politely", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(
      responseWithJson(Promise.resolve(invoiceResult)),
    ));

    await selectReadyFile(new File(["invoice"], "invoice.jpg", { type: "image/jpeg" }));
    await clickButtonByTitle("Export as CSV");

    const status = findRegion("status", "Exported 1 wines to CSV");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.querySelector('svg[class*="check"]')?.getAttribute("aria-hidden")).toBe("true");
  });

  it("announces the persistent saved-result text without including its actions", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(responseWithJson(Promise.resolve(invoiceResult)))
      .mockResolvedValueOnce(responseWithJson(Promise.resolve({
        scanId: "saved-scan-1",
        itemCount: 2,
        wineCount: 2,
      })));
    vi.stubGlobal("fetch", fetchMock);

    await selectReadyFile(new File(["invoice"], "invoice.jpg", { type: "image/jpeg" }));
    await clickButton("Save to Inventory");

    const status = findRegion("status", "Saved 2 items to inventory");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.querySelector("a, button")).toBeNull();
    expect(status.contains(linkNamed("Add to wine list"))).toBe(false);
    expect(status.contains(buttonNamed("Dismiss"))).toBe(false);
  });

  it("announces an accuracy export failure without reporting success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(
      responseWithJson(Promise.resolve(invoiceResult)),
    ));
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      throw new Error("accuracy export blocked");
    });

    await selectReadyFile(new File(["invoice"], "invoice.jpg", { type: "image/jpeg" }));
    await clickButtonByTitle("Export accuracy JSON (source + items + per-field edits)");

    findRegion("alert", "accuracy export blocked");
    expect(container.textContent).not.toContain("Exported accuracy report");
  });

  it("reports accuracy-export cleanup failures instead of announcing success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(
      responseWithJson(Promise.resolve(invoiceResult)),
    ));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:accuracy-report");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {
      throw new Error("accuracy cleanup blocked");
    });

    await selectReadyFile(new File(["invoice"], "invoice.jpg", { type: "image/jpeg" }));
    await clickButtonByTitle("Export accuracy JSON (source + items + per-field edits)");

    findRegion("alert", "accuracy cleanup blocked");
    expect(container.textContent).not.toContain("Exported accuracy report");
  });
});

async function selectReadyFile(file: File) {
  const input = [...container.querySelectorAll<HTMLInputElement>('input[type="file"]')].at(-1);
  if (!input) throw new Error("Could not find ready-state file input");
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
}

async function clickButton(name: string) {
  const button = buttonNamed(name);
  await act(async () => button.click());
}

async function clickButtonByTitle(title: string) {
  const button = container.querySelector<HTMLButtonElement>(`button[title="${title}"]`);
  if (!button) throw new Error(`Could not find button titled ${title}`);
  await act(async () => button.click());
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

function findRegion(role: "alert" | "status", text: string): HTMLElement {
  const region = [...container.querySelectorAll<HTMLElement>(`[role="${role}"]`)].find(
    (candidate) => candidate.textContent?.includes(text),
  );
  if (!region) throw new Error(`Could not find ${role} containing ${text}`);
  return region;
}

function progressbar(): HTMLElement {
  const element = container.querySelector<HTMLElement>('[role="progressbar"]');
  if (!element) throw new Error("Could not find progressbar");
  return element;
}

function responseWithJson<T>(json: Promise<T>): Response {
  return {
    ok: true,
    status: 200,
    json: () => json,
  } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}
