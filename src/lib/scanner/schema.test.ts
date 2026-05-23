import { describe, expect, it } from "vitest";
import {
  PERSISTED_SCAN_VERSION,
  PersistedScanSchema,
} from "./schema";

/**
 * BND-024 — guards against silent data-shape drift in the localStorage
 * persistence envelope used by the scanner. The schema is the runtime
 * contract; these tests pin it so shape regressions surface immediately.
 */
describe("PersistedScanSchema", () => {
  const validEnvelope = {
    version: PERSISTED_SCAN_VERSION,
    data: {
      source: {
        distributor: "Kermit Lynch",
        invoiceNo: "KL-48219",
        invoiceDate: "2026-04-15",
        parsedAt: "2026-04-15T10:00:00.000Z",
      },
      items: [
        {
          id: "item-1",
          name: "Volnay 1er Cru",
          producer: "Domaine Leflaive",
          vintage: 2019,
          varietal: "Pinot Noir",
          region: "Burgundy",
          qty: 6,
          unitCost: 85.5,
          currency: "USD",
          format: "750ml",
          confidence: 0.92,
        },
      ],
      edits: { "item-1:name": true as const },
    },
  };

  it("accepts a valid envelope and returns the parsed data", () => {
    const result = PersistedScanSchema.safeParse(validEnvelope);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.version).toBe(PERSISTED_SCAN_VERSION);
      expect(result.data.data.items).toHaveLength(1);
    }
  });

  it("rejects version mismatch (v0 legacy blob)", () => {
    const legacy = { version: 0, data: validEnvelope.data };
    const result = PersistedScanSchema.safeParse(legacy);
    expect(result.success).toBe(false);
  });

  it("rejects a raw Scan without the envelope wrapper", () => {
    const result = PersistedScanSchema.safeParse(validEnvelope.data);
    expect(result.success).toBe(false);
  });

  it("rejects malformed items (string instead of number for unitCost)", () => {
    const bad = {
      ...validEnvelope,
      data: {
        ...validEnvelope.data,
        items: [{ ...validEnvelope.data.items[0], unitCost: "85.50" }],
      },
    };
    const result = PersistedScanSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("accepts items with null vintage (non-vintage wines)", () => {
    const nv = {
      ...validEnvelope,
      data: {
        ...validEnvelope.data,
        items: [{ ...validEnvelope.data.items[0], vintage: null }],
      },
    };
    const result = PersistedScanSchema.safeParse(nv);
    expect(result.success).toBe(true);
  });

  it("accepts the optional quality block when present", () => {
    const withQuality = {
      ...validEnvelope,
      data: {
        ...validEnvelope.data,
        quality: {
          avgConfidence: 0.91,
          lowConfidenceItems: 0,
          totalItems: 1,
          manualFallbackTriggered: false,
        },
      },
    };
    const result = PersistedScanSchema.safeParse(withQuality);
    expect(result.success).toBe(true);
  });
});
