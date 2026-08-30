import { describe, expect, it } from "vitest";
import type { Scan } from "@/lib/scanner/types";
import { initialScannerState, scannerReducer, type ScannerState } from "./scanner-state";

function baseScan(overrides: Partial<Scan> = {}): Scan {
  return {
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
    ...overrides,
  };
}

describe("scannerReducer", () => {
  it("starts in ready with empty payload state", () => {
    expect(initialScannerState.status).toBe("ready");
    expect(initialScannerState.scan).toBeNull();
    expect(initialScannerState.lastFiles).toEqual([]);
  });

  it("scan-restored lands on results without touching progress/originalItems", () => {
    const scan = baseScan();
    const next = scannerReducer(initialScannerState, { type: "scan-restored", scan });
    expect(next.status).toBe("results");
    expect(next.scan).toBe(scan);
    expect(next.originalItems).toEqual([]);
  });

  it("invoice-rejected clears both lastFile and lastFiles (no retry offered)", () => {
    const seeded: ScannerState = {
      ...initialScannerState,
      lastFile: new File(["x"], "a.jpg"),
      lastFiles: [new File(["x"], "a.jpg")],
    };
    const next = scannerReducer(seeded, { type: "invoice-rejected", message: "nope" });
    expect(next.lastFile).toBeNull();
    expect(next.lastFiles).toEqual([]);
    expect(next.error).toBe("nope");
    expect(next.status).toBe("error");
  });

  it("invoice-scan-started tracks the first file plus the full batch", () => {
    const files = [new File(["a"], "a.jpg"), new File(["b"], "b.jpg")];
    const next = scannerReducer(initialScannerState, { type: "invoice-scan-started", files });
    expect(next.lastFile).toBe(files[0]);
    expect(next.lastFiles).toBe(files);
    expect(next.status).toBe("processing");
    expect(next.progress).toBe(0);
  });

  it("invoice-scan-succeeded routes to review when manualFallbackTriggered", () => {
    const scan = baseScan({
      quality: { avgConfidence: 0.5, lowConfidenceItems: 1, totalItems: 1, manualFallbackTriggered: true },
    });
    const next = scannerReducer(initialScannerState, { type: "invoice-scan-succeeded", scan });
    expect(next.status).toBe("review");
    expect(next.progress).toBe(100);
    expect(next.originalItems).toEqual(scan.items);
  });

  it("invoice-scan-succeeded routes to results without the fallback flag", () => {
    const scan = baseScan();
    const next = scannerReducer(initialScannerState, { type: "invoice-scan-succeeded", scan });
    expect(next.status).toBe("results");
  });

  it("invoice-scan-failed preserves lastFile/lastFiles so retry can resubmit", () => {
    const files = [new File(["a"], "a.jpg")];
    const seeded: ScannerState = { ...initialScannerState, lastFile: files[0], lastFiles: files };
    const next = scannerReducer(seeded, {
      type: "invoice-scan-failed",
      message: "boom",
      rawText: "raw",
    });
    expect(next.lastFile).toBe(files[0]);
    expect(next.lastFiles).toBe(files);
    expect(next.error).toBe("boom");
    expect(next.rawText).toBe("raw");
    expect(next.status).toBe("error");
  });

  it("field-updated marks the edit and is a no-op without a scan", () => {
    const scan = baseScan();
    const seeded: ScannerState = { ...initialScannerState, scan };
    const next = scannerReducer(seeded, {
      type: "field-updated",
      id: "item-1",
      field: "name",
      value: "Renamed",
    });
    expect(next.scan?.items[0].name).toBe("Renamed");
    expect(next.scan?.edits["item-1:name"]).toBe(true);

    const noop = scannerReducer(initialScannerState, {
      type: "field-updated",
      id: "item-1",
      field: "name",
      value: "x",
    });
    expect(noop).toBe(initialScannerState);
  });

  it("source-updated patches only the source field given", () => {
    const scan = baseScan();
    const seeded: ScannerState = { ...initialScannerState, scan };
    const next = scannerReducer(seeded, {
      type: "source-updated",
      field: "distributor",
      value: "New Distributor",
    });
    expect(next.scan?.source.distributor).toBe("New Distributor");
    expect(next.scan?.source.invoiceNo).toBe(scan.source.invoiceNo);
  });

  it("item-removed filters the item out", () => {
    const scan = baseScan();
    const seeded: ScannerState = { ...initialScannerState, scan };
    const next = scannerReducer(seeded, { type: "item-removed", id: "item-1" });
    expect(next.scan?.items).toEqual([]);
  });

  it("reset clears scan and bottleResult but leaves lastFile/lastFiles/progress/originalItems/savedResult untouched", () => {
    const files = [new File(["a"], "a.jpg")];
    const seeded: ScannerState = {
      ...initialScannerState,
      scan: baseScan(),
      bottleResult: { candidates: [], parsedAt: "now" },
      lastFile: files[0],
      lastFiles: files,
      progress: 42,
      originalItems: baseScan().items,
      savedResult: { itemCount: 1, wineCount: 1 },
    };
    const next = scannerReducer(seeded, { type: "reset" });
    expect(next.scan).toBeNull();
    expect(next.bottleResult).toBeNull();
    expect(next.status).toBe("ready");
    // Deliberately preserved — matches the original startOver, which
    // never reset these fields either.
    expect(next.lastFile).toBe(files[0]);
    expect(next.lastFiles).toBe(files);
    expect(next.progress).toBe(42);
    expect(next.originalItems).toEqual(baseScan().items);
    expect(next.savedResult).toEqual({ itemCount: 1, wineCount: 1 });
  });

  it("scan-cancelled resets progress/error/rawText/status but leaves scan/bottleResult alone", () => {
    const scan = baseScan();
    const seeded: ScannerState = { ...initialScannerState, scan, progress: 55, error: "e", rawText: "r" };
    const next = scannerReducer(seeded, { type: "scan-cancelled" });
    expect(next.progress).toBe(0);
    expect(next.error).toBeNull();
    expect(next.rawText).toBeNull();
    expect(next.status).toBe("ready");
    expect(next.scan).toBe(scan);
  });

  it("invoice-saved clears scan/originalItems and records the saved counts, leaving error/rawText/bottleResult alone", () => {
    const seeded: ScannerState = {
      ...initialScannerState,
      scan: baseScan(),
      originalItems: baseScan().items,
      error: "stale",
      rawText: "stale",
      bottleResult: { candidates: [], parsedAt: "now" },
    };
    const next = scannerReducer(seeded, {
      type: "invoice-saved",
      result: { itemCount: 2, wineCount: 2 },
    });
    expect(next.scan).toBeNull();
    expect(next.originalItems).toEqual([]);
    expect(next.savedResult).toEqual({ itemCount: 2, wineCount: 2 });
    expect(next.status).toBe("ready");
    expect(next.error).toBe("stale");
    expect(next.rawText).toBe("stale");
    expect(next.bottleResult).not.toBeNull();
  });

  it("manual-entry-started does not clear rawText (it seeds the new scan from it)", () => {
    const seeded: ScannerState = { ...initialScannerState, rawText: "ocr text", error: "e" };
    const scan = baseScan({ rawText: "ocr text" });
    const next = scannerReducer(seeded, { type: "manual-entry-started", scan });
    expect(next.scan).toBe(scan);
    expect(next.error).toBeNull();
    expect(next.rawText).toBe("ocr text");
    expect(next.status).toBe("results");
  });

  it("bottle-rejected clears lastFile only, not lastFiles", () => {
    const files = [new File(["a"], "a.jpg")];
    const seeded: ScannerState = { ...initialScannerState, lastFile: files[0], lastFiles: files };
    const next = scannerReducer(seeded, { type: "bottle-rejected", message: "too big" });
    expect(next.lastFile).toBeNull();
    expect(next.lastFiles).toBe(files);
    expect(next.error).toBe("too big");
    expect(next.status).toBe("error");
  });

  it("bottle-scan-started/succeeded transitions", () => {
    const file = new File(["a"], "a.jpg");
    const started = scannerReducer(initialScannerState, { type: "bottle-scan-started", file });
    expect(started.lastFile).toBe(file);
    expect(started.status).toBe("processing");

    const result = { candidates: [], parsedAt: "now" };
    const succeeded = scannerReducer(started, { type: "bottle-scan-succeeded", result });
    expect(succeeded.bottleResult).toBe(result);
    expect(succeeded.status).toBe("bottle-results");
    expect(succeeded.progress).toBe(100);
  });

  it("bottle-scan-failed sets error/status but leaves rawText untouched", () => {
    const seeded: ScannerState = { ...initialScannerState, rawText: "kept" };
    const next = scannerReducer(seeded, { type: "bottle-scan-failed", message: "fail" });
    expect(next.error).toBe("fail");
    expect(next.status).toBe("error");
    expect(next.rawText).toBe("kept");
  });

  it("bottle-saved clears bottleResult and records the saved counts", () => {
    const seeded: ScannerState = {
      ...initialScannerState,
      bottleResult: { candidates: [], parsedAt: "now" },
    };
    const next = scannerReducer(seeded, { type: "bottle-saved" });
    expect(next.bottleResult).toBeNull();
    expect(next.savedResult).toEqual({ itemCount: 1, wineCount: 1 });
    expect(next.status).toBe("ready");
  });

  it("saved-result-dismissed clears savedResult only", () => {
    const seeded: ScannerState = {
      ...initialScannerState,
      savedResult: { itemCount: 1, wineCount: 1 },
      status: "ready",
    };
    const next = scannerReducer(seeded, { type: "saved-result-dismissed" });
    expect(next.savedResult).toBeNull();
    expect(next.status).toBe("ready");
  });

  it("progress-tick only updates progress", () => {
    const next = scannerReducer(initialScannerState, { type: "progress-tick", progress: 63 });
    expect(next.progress).toBe(63);
    expect(next.status).toBe("ready");
  });
});
