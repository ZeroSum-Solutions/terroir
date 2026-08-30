import { beforeEach, describe, expect, it, vi } from "vitest";
import { PERSISTED_SCAN_VERSION } from "./schema";
import type { Scan } from "./types";

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

const STORAGE_KEY = "terroir:current-scan";

const baseScan: Scan = {
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
  rawText: "raw ocr dump that should never be persisted",
};

beforeEach(() => {
  vi.stubGlobal("Storage", MemoryStorage);
  vi.stubGlobal("localStorage", new MemoryStorage());
});

describe("saveScan / loadScan", () => {
  it("round-trips a scan through localStorage", async () => {
    const { loadScan, saveScan } = await import("./scan-storage");
    saveScan(baseScan);
    const loaded = loadScan();
    expect(loaded?.source).toEqual(baseScan.source);
    expect(loaded?.items).toEqual(baseScan.items);
    expect(loaded?.edits).toEqual(baseScan.edits);
  });

  it("strips rawText before persisting, to avoid bloating localStorage with OCR dumps", async () => {
    const { saveScan } = await import("./scan-storage");
    saveScan(baseScan);
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(raw.data.rawText).toBeUndefined();
  });

  it("wraps the persisted data in the current version envelope", async () => {
    const { saveScan } = await import("./scan-storage");
    saveScan(baseScan);
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(raw.version).toBe(PERSISTED_SCAN_VERSION);
  });

  it("removes the stored key when saving null", async () => {
    const { loadScan, saveScan } = await import("./scan-storage");
    saveScan(baseScan);
    saveScan(null);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(loadScan()).toBeNull();
  });

  it("returns null and clears storage on malformed JSON", async () => {
    const { loadScan } = await import("./scan-storage");
    localStorage.setItem(STORAGE_KEY, "not json{");
    expect(loadScan()).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("returns null and clears storage when the schema doesn't validate", async () => {
    const { loadScan } = await import("./scan-storage");
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: PERSISTED_SCAN_VERSION, data: { nope: true } }),
    );
    expect(loadScan()).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("returns null and clears storage on a stale version envelope", async () => {
    const { loadScan, saveScan } = await import("./scan-storage");
    saveScan(baseScan);
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    raw.version = PERSISTED_SCAN_VERSION + 1;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(raw));
    expect(loadScan()).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("returns null without touching storage when nothing is stored", async () => {
    const { loadScan } = await import("./scan-storage");
    expect(loadScan()).toBeNull();
  });
});
