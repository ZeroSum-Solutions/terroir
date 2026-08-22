import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * M1-1 — proves `processInvoiceScanOnce` emits the expected per-stage
 * Sentry spans end-to-end: one `scan.ocr.page` span per page, one
 * `scan.ocr.merge`, `scan.extract` (attempt 1), `scan.extract.retry`
 * (attempt 2 — only on the G1-12 arithmetic-mismatch retry path, as its
 * own distinctly-named span), and `scan.persist`. Same mocking pattern as
 * `invoice-scan-service.arithmetic.test.ts` / `.test.ts`: OCR and
 * extraction are mocked at the adapter boundary, no live API calls.
 *
 * `@sentry/nextjs`'s `startSpan` is mocked to record every call's
 * `{name, op, attributes}` and simply run the callback — this proves
 * spans are emitted with the right shape without needing a real Sentry
 * backend, and without changing what the wrapped stage returns.
 */

type SpanCall = {
  name: string;
  op?: string;
  attributes?: Record<string, unknown>;
};

const spanCalls: SpanCall[] = [];

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
  AiExtractError: class AiExtractError extends Error {},
  extractFromOcr: (...args: unknown[]) => mockExtractFromOcr(...args),
}));
vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
  startSpan: (options: SpanCall, callback: () => unknown) => {
    spanCalls.push(options);
    return callback();
  },
}));

const { processInvoiceScanOnce } = await import("./invoice-scan-service");

function lineItem(overrides: Record<string, unknown> = {}) {
  return {
    name: "Volnay",
    producer: "Domaine Test",
    vintage: 2022,
    varietal: "Pinot Noir",
    region: "Burgundy",
    currency: "USD",
    format: "750ml",
    lowFields: [],
    ...overrides,
  };
}

/** Three-line invoice where every line and the invoice total reconcile. */
function reconciledInvoice(confidence = 0.95) {
  return {
    distributor: "Test Distributor",
    invoiceNumber: "INV-1",
    invoiceDate: "2026-07-24",
    lineItems: [
      lineItem({ qty: 6, unitCost: 45, lineTotal: 270, confidence }),
      lineItem({ name: "Barolo", qty: 3, unitCost: 62.5, lineTotal: 187.5, confidence }),
      lineItem({ name: "Chablis", qty: 12, unitCost: 28, lineTotal: 336, confidence }),
    ],
    invoiceTotal: 793.5,
    taxAndFees: null,
  };
}

/** Same invoice, but the third line's unit cost was misread (28 -> 18). */
function mismatchedInvoice(confidence = 0.9) {
  const invoice = reconciledInvoice(confidence);
  invoice.lineItems[2] = lineItem({
    name: "Chablis",
    qty: 12,
    unitCost: 18,
    lineTotal: 336,
    confidence,
  });
  return invoice;
}

function makeSupabase() {
  const builder = {
    update: vi.fn(() => builder),
    eq: vi.fn(async () => ({ data: null, error: null })),
  };
  return { supabase: { from: vi.fn(() => builder) } };
}

async function runScan(
  supabase: unknown,
  extra: Partial<Parameters<typeof processInvoiceScanOnce>[0]> = {},
) {
  return processInvoiceScanOnce({
    supabase: supabase as never,
    restaurantId: "restaurant-a",
    userId: "user-a",
    fileBuffer: Buffer.from("invoice"),
    mimeType: "image/jpeg",
    preCreatedScanId: "scan-a",
    ...extra,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  spanCalls.length = 0;
  mockExtractOcr.mockResolvedValue({ rawText: "invoice text", tables: [] });
});

describe("processInvoiceScanOnce — M1-1 per-stage span emission", () => {
  it("emits ocr.page, ocr.merge, extract, and persist spans in order for a single-page reconciled scan", async () => {
    mockExtractFromOcr.mockResolvedValueOnce(reconciledInvoice());
    const { supabase } = makeSupabase();

    const result = await runScan(supabase);

    expect(result.status).toBe(200);
    expect(spanCalls.map((s) => s.name)).toEqual([
      "scan.ocr.page",
      "scan.ocr.merge",
      "scan.extract",
      "scan.persist",
    ]);
    expect(spanCalls.every((s) => s.op === "scan")).toBe(true);

    const [ocrPage, ocrMerge, extract, persist] = spanCalls;
    expect(ocrPage.attributes).toMatchObject({
      pageIndex: 0,
      pageCount: 1,
      mimeType: "image/jpeg",
    });
    expect(ocrMerge.attributes).toMatchObject({ pageCount: 1 });
    expect(extract.attributes).toMatchObject({ attempt: 1 });
    expect(persist.attributes).toMatchObject({ itemCount: 3, arithmeticOk: true });
  });

  it("emits one ocr.page span per page for a multi-page batch, plus a single ocr.merge", async () => {
    mockExtractOcr.mockImplementation(async (buffer: Buffer) =>
      buffer.toString() === "page one"
        ? { rawText: "PAGE ONE", tables: [] }
        : { rawText: "PAGE TWO", tables: [] },
    );
    mockExtractFromOcr.mockResolvedValueOnce(reconciledInvoice());
    const { supabase } = makeSupabase();

    await runScan(supabase, {
      fileBuffer: Buffer.from("page one"),
      extraFiles: [{ buffer: Buffer.from("page two"), mimeType: "image/png" }],
    });

    const pageSpans = spanCalls.filter((s) => s.name === "scan.ocr.page");
    expect(pageSpans).toHaveLength(2);
    expect(pageSpans[0].attributes).toMatchObject({ pageIndex: 0, pageCount: 2, mimeType: "image/jpeg" });
    expect(pageSpans[1].attributes).toMatchObject({ pageIndex: 1, pageCount: 2, mimeType: "image/png" });
    expect(spanCalls.filter((s) => s.name === "scan.ocr.merge")).toHaveLength(1);
  });

  it("emits a distinctly-named extract.retry span (attempt 2) on the G1-12 arithmetic-mismatch retry path", async () => {
    mockExtractFromOcr
      .mockResolvedValueOnce(mismatchedInvoice())
      .mockResolvedValueOnce(reconciledInvoice(0.97));
    const { supabase } = makeSupabase();

    const result = await runScan(supabase);

    expect(result.status).toBe(200);
    const names = spanCalls.map((s) => s.name);
    expect(names).toEqual([
      "scan.ocr.page",
      "scan.ocr.merge",
      "scan.extract",
      "scan.extract.retry",
      "scan.persist",
    ]);

    const extractSpan = spanCalls.find((s) => s.name === "scan.extract");
    const retrySpan = spanCalls.find((s) => s.name === "scan.extract.retry");
    expect(extractSpan?.attributes).toMatchObject({ attempt: 1 });
    expect(retrySpan?.attributes).toMatchObject({ attempt: 2 });
    // Exactly one retry span — mirrors the G1-12 "exactly one retry" invariant.
    expect(names.filter((n) => n === "scan.extract.retry")).toHaveLength(1);

    const persistSpan = spanCalls.find((s) => s.name === "scan.persist");
    expect(persistSpan?.attributes).toMatchObject({ arithmeticOk: true });
  });

  it("still emits persist with arithmeticOk: false when the retry itself fails validation", async () => {
    mockExtractFromOcr
      .mockResolvedValueOnce(mismatchedInvoice())
      .mockResolvedValueOnce(mismatchedInvoice());
    const { supabase } = makeSupabase();

    const result = await runScan(supabase);

    expect(result.status).toBe(200);
    expect(spanCalls.filter((s) => s.name === "scan.extract.retry")).toHaveLength(1);
    const persistSpan = spanCalls.find((s) => s.name === "scan.persist");
    expect(persistSpan?.attributes).toMatchObject({ arithmeticOk: false });
  });

  it("does not emit an extract.retry span, and does not change the response, when startSpan is unavailable", async () => {
    // Re-import with a minimal Sentry mock (no `startSpan` at all) — the
    // same shape several other test files in this repo already use for
    // @sentry/nextjs — to prove withScanSpan's fallback keeps the scan
    // itself byte-for-byte identical when instrumentation is unusable.
    vi.resetModules();
    vi.doMock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
    vi.doMock("@/adapters/ocr/azure-document-intelligence", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("@/adapters/ocr/azure-document-intelligence")>();
      return {
        ...actual,
        OcrError: class OcrError extends Error {},
        extractOcr: (...args: unknown[]) => mockExtractOcr(...args),
      };
    });
    vi.doMock("@/adapters/llm/anthropic-invoice-extraction", () => ({
      AiExtractError: class AiExtractError extends Error {},
      extractFromOcr: (...args: unknown[]) => mockExtractFromOcr(...args),
    }));
    const { processInvoiceScanOnce: processWithoutStartSpan } = await import(
      "./invoice-scan-service"
    );

    mockExtractFromOcr
      .mockResolvedValueOnce(mismatchedInvoice())
      .mockResolvedValueOnce(reconciledInvoice(0.97));
    const { supabase } = makeSupabase();

    const result = await processWithoutStartSpan({
      supabase: supabase as never,
      restaurantId: "restaurant-a",
      userId: "user-a",
      fileBuffer: Buffer.from("invoice"),
      mimeType: "image/jpeg",
      preCreatedScanId: "scan-a",
    });

    expect(result.status).toBe(200);
    expect(mockExtractFromOcr).toHaveBeenCalledTimes(2);
    const body = result.body as { arithmetic: { ok: boolean } };
    expect(body.arithmetic.ok).toBe(true);
  });
});
