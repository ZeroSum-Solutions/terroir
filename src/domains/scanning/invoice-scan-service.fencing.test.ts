import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Grok-2 — invoice_scans writes must be fenced to the row still being
 * 'processing'. Both entry paths set invoice_scans.status='processing'
 * before/at the start of a run (route.ts pre-created rows, this service's
 * fresh-insert path); a worker reclaimed mid-call (heartbeat.ts documents
 * renewal failures are best-effort) must never have its late write — the
 * success persist, or the catch-path failure write — clobber a result
 * another worker's attempt already persisted.
 */

class MockAiExtractError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AiExtractError";
    this.code = code;
  }
}

const mockExtractOcr = vi.fn();
const mockExtractFromOcr = vi.fn();
vi.mock("@/adapters/ocr/azure-document-intelligence", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/adapters/ocr/azure-document-intelligence")>();
  return {
    ...actual,
    OcrError: class OcrError extends Error {},
    extractOcr: (...args: unknown[]) => mockExtractOcr(...args),
  };
});
vi.mock("@/adapters/llm/anthropic-invoice-extraction", () => ({
  AiExtractError: MockAiExtractError,
  extractFromOcr: (...args: unknown[]) => mockExtractFromOcr(...args),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const { processInvoiceScanOnce } = await import("./invoice-scan-service");

function lineItem(overrides: Record<string, unknown> = {}) {
  return {
    name: "Volnay",
    producer: "Domaine Test",
    vintage: 2022,
    varietal: "Pinot Noir",
    region: "Burgundy",
    qty: 6,
    unitCost: 45,
    lineTotal: 270,
    currency: "USD",
    format: "750ml",
    confidence: 0.95,
    lowFields: [],
    ...overrides,
  };
}

function reconciledInvoice() {
  return {
    distributor: "Test Distributor",
    invoiceNumber: "INV-1",
    invoiceDate: "2026-07-24",
    lineItems: [lineItem()],
    invoiceTotal: 270,
    taxAndFees: null,
  };
}

/**
 * A chainable AND directly-awaitable supabase stub, matching real
 * supabase-js query builders, that records every `.eq()` filter applied
 * to each `.update()` call and resolves every update with `persistResult`.
 */
function makeFencedSupabase(persistResult: { data: unknown; error: unknown }) {
  const eqCallsByUpdate: Array<Array<[string, unknown]>> = [];
  const supabase = {
    from: vi.fn(() => ({
      update: vi.fn(() => {
        const calls: Array<[string, unknown]> = [];
        eqCallsByUpdate.push(calls);
        const node: Record<string, unknown> = {};
        node.eq = vi.fn((col: string, val: unknown) => {
          calls.push([col, val]);
          return node;
        });
        node.select = vi.fn(() => node);
        node.then = (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
          Promise.resolve(persistResult).then(resolve, reject);
        return node;
      }),
    })),
  };
  return { supabase, eqCallsByUpdate };
}

async function runScan(supabase: unknown) {
  return processInvoiceScanOnce({
    supabase: supabase as never,
    restaurantId: "restaurant-a",
    userId: "user-a",
    fileBuffer: Buffer.from("invoice"),
    mimeType: "image/jpeg",
    preCreatedScanId: "scan-a",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExtractOcr.mockResolvedValue({ rawText: "invoice text", tables: [] });
});

describe("processInvoiceScanOnce — Grok-2 fenced invoice_scans writes", () => {
  it("returns 409 scan_superseded when the persist fence misses (row already moved off 'processing')", async () => {
    mockExtractFromOcr.mockResolvedValueOnce(reconciledInvoice());
    const { supabase, eqCallsByUpdate } = makeFencedSupabase({ data: [], error: null });

    const result = await runScan(supabase);

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ scanId: "scan-a", code: "scan_superseded" });
    // Fenced on the row still being 'processing' — this is what stops a
    // stale worker's write from stomping a result another attempt
    // already persisted.
    expect(eqCallsByUpdate[0]).toEqual([
      ["id", "scan-a"],
      ["status", "processing"],
    ]);
  });

  it("persists normally (200) when the fence matches", async () => {
    mockExtractFromOcr.mockResolvedValueOnce(reconciledInvoice());
    const { supabase } = makeFencedSupabase({ data: [{ id: "scan-a" }], error: null });

    const result = await runScan(supabase);

    expect(result.status).toBe(200);
  });

  it("fences the catch-path failed write on status='processing' too", async () => {
    mockExtractFromOcr.mockRejectedValueOnce(
      new MockAiExtractError("upstream_error", "The AI service encountered an error."),
    );
    const { supabase, eqCallsByUpdate } = makeFencedSupabase({ data: [], error: null });

    const result = await runScan(supabase);

    // The outer catch still maps this worker's own extraction failure
    // correctly — fencing only governs whether the *write* takes effect,
    // never this worker's own view of its own attempt's outcome.
    expect(result.status).toBe(502);
    expect((result.body as { code: string }).code).toBe("upstream_error");
    expect(eqCallsByUpdate[0]).toEqual([
      ["id", "scan-a"],
      ["status", "processing"],
    ]);
  });
});
