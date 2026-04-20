/**
 * Reusable Scan / LineItem fixtures for /api/inventory/save-scan tests
 * (BND-010). Kept separate from the mocks file so the fixtures stay
 * importable in any test, including ones that don't mock the Anthropic /
 * Azure modules.
 */
import type { LineItem, Scan } from "@/lib/scanner/types";

export function makeLineItem(overrides: Partial<LineItem> = {}): LineItem {
  return {
    id: "item-1",
    name: "Pinot Noir",
    producer: "Domaine Drouhin",
    vintage: 2019,
    varietal: "Pinot Noir",
    region: "Willamette Valley",
    qty: 6,
    unitCost: 32.5,
    confidence: 0.92,
    ...overrides,
  };
}

export function makeScan(overrides: Partial<Scan> = {}): Scan {
  return {
    source: {
      distributor: "Test Distributor",
      invoiceNo: "INV-1001",
      invoiceDate: "2026-04-01",
      parsedAt: "2026-04-19T12:00:00.000Z",
    },
    items: [
      makeLineItem({ id: "item-1" }),
      makeLineItem({
        id: "item-2",
        name: "Cabernet Sauvignon",
        producer: "Château Margaux",
        vintage: 2015,
        varietal: "Cabernet Sauvignon",
        region: "Bordeaux",
        qty: 3,
        unitCost: 850,
      }),
    ],
    edits: {},
    rawText: "raw OCR text",
    ...overrides,
  };
}

/** Returned by the Claude `messages.parse` happy-path stub. */
export function makeParsedInvoice() {
  return {
    parsed_output: {
      distributor: "Test Distributor",
      invoiceNumber: "INV-1001",
      invoiceDate: "2026-04-01",
      lineItems: [
        {
          name: "Pinot Noir",
          producer: "Domaine Drouhin",
          vintage: 2019,
          varietal: "Pinot Noir",
          region: "Willamette Valley",
          qty: 6,
          unitCost: 32.5,
          confidence: 0.92,
          lowFields: [],
        },
        {
          name: "Cabernet Sauvignon",
          producer: "Château Margaux",
          vintage: 2015,
          varietal: "Cabernet Sauvignon",
          region: "Bordeaux",
          qty: 3,
          unitCost: 850,
          confidence: 0.95,
          lowFields: [],
        },
      ],
    },
  };
}
