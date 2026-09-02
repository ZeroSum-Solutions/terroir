/**
 * Unit tests for `extractFromOcr` and `buildOcrContext` (BND-011).
 *
 * Same vi.hoisted-anthropic-mock pattern as `route.test.ts` — see that file
 * for the rationale. The Anthropic singleton is reset per test so the
 * `not_configured` scenario is order-independent.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OcrResult } from "./ocr-service";

const anthropic = vi.hoisted(() => {
  class APIError extends Error {}
  class RateLimitError extends APIError {}
  class BadRequestError extends APIError {}
  return {
    ctor: vi.fn(),
    parse: vi.fn(),
    create: vi.fn(),
    APIError,
    RateLimitError,
    BadRequestError,
  };
});
vi.mock("@anthropic-ai/sdk", () => ({
  default: class Anthropic {
    messages = { parse: anthropic.parse, create: anthropic.create };
    static APIError = anthropic.APIError;
    static RateLimitError = anthropic.RateLimitError;
    static BadRequestError = anthropic.BadRequestError;
    constructor(...args: unknown[]) {
      anthropic.ctor(...args);
    }
  },
}));
vi.mock("@anthropic-ai/sdk/helpers/zod", () => ({
  zodOutputFormat: () => ({ type: "json_schema", schema: {} }),
}));

const { extractFromOcr, buildOcrContext, AiExtractError } = await import(
  "./ai-extract"
);
const { __resetAnthropicClientForTests } = await import(
  "@/lib/ai/anthropic-client"
);

function okOcr(overrides: Partial<OcrResult> = {}): OcrResult {
  return {
    rawText: "Invoice #123\nLine 1 ...",
    vendorName: "Test Distributor",
    invoiceNumber: "INV-1001",
    invoiceDate: "2026-04-01",
    tables: [
      { description: "Pinot Noir", quantity: 6, unitPrice: 32.5, amount: 195 },
    ],
    ...overrides,
  };
}

function happyParse() {
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
          currency: "USD",
          format: "750ml",
          confidence: 0.92,
          lowFields: [],
        },
      ],
    },
  };
}

describe("buildOcrContext", () => {
  it("wraps rawText in <invoice_text> and escapes XML metacharacters", () => {
    const ctx = buildOcrContext(
      okOcr({ rawText: "<script>alert('x')</script> & raw" }),
    );
    expect(ctx).toContain(
      "<invoice_text>\n&lt;script&gt;alert('x')&lt;/script&gt; &amp; raw\n</invoice_text>",
    );
  });

  it("includes optional vendor / invoice / date fields when present", () => {
    const ctx = buildOcrContext(okOcr());
    expect(ctx).toContain("<detected_vendor>Test Distributor</detected_vendor>");
    expect(ctx).toContain("<detected_invoice_number>INV-1001</detected_invoice_number>");
    expect(ctx).toContain("<detected_invoice_date>2026-04-01</detected_invoice_date>");
  });

  it("omits optional fields when missing", () => {
    const ctx = buildOcrContext(
      okOcr({
        vendorName: undefined,
        invoiceNumber: undefined,
        invoiceDate: undefined,
        tables: [],
      }),
    );
    expect(ctx).not.toContain("<detected_vendor>");
    expect(ctx).not.toContain("<detected_invoice_number>");
    expect(ctx).not.toContain("<detected_invoice_date>");
    expect(ctx).not.toContain("<detected_line_items>");
  });

  it("renders detected_line_items with the parts that are present", () => {
    const ctx = buildOcrContext(
      okOcr({
        tables: [
          { description: "Wine A", quantity: 6, unitPrice: 12, amount: 72 },
          { description: "Wine B" }, // no metadata
        ],
      }),
    );
    expect(ctx).toContain("- Wine A | qty: 6 | unit: $12 | total: $72");
    expect(ctx).toContain("- Wine B");
    // Wine B should not have qty/unit/total fields since they're absent.
    expect(ctx).not.toContain("Wine B | qty");
  });
});

describe("extractFromOcr", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetAnthropicClientForTests();
    process.env.OPENROUTER_API_KEY = "sk-test";
  });

  it("returns the parsed_output on success", async () => {
    anthropic.parse.mockResolvedValue(happyParse());

    const parsed = await extractFromOcr(okOcr());

    expect(parsed.distributor).toBe("Test Distributor");
    expect(parsed.lineItems).toHaveLength(1);
    expect(parsed.lineItems[0].name).toBe("Pinot Noir");
    // Sanity: the route's intended args were forwarded.
    const callArgs = anthropic.parse.mock.calls[0][0];
    expect(callArgs.model).toBe("anthropic/claude-sonnet-5");
    expect(callArgs.max_tokens).toBe(16000);
    expect(callArgs.output_config.effort).toBe("medium");
    expect(callArgs.messages[0].role).toBe("user");
    expect(callArgs.messages[0].content).toContain("<invoice_text>");
  });

  it("uses the provided profile instead of the default (G1-12 retry path)", async () => {
    anthropic.parse.mockResolvedValue(happyParse());

    await extractFromOcr(okOcr(), {
      model: "anthropic/claude-sonnet-5",
      effort: "high",
      maxTokens: 24000,
    });

    const callArgs = anthropic.parse.mock.calls[0][0];
    expect(callArgs.model).toBe("anthropic/claude-sonnet-5");
    expect(callArgs.max_tokens).toBe(24000);
    expect(callArgs.output_config.effort).toBe("high");
  });

  it("throws AiExtractError('not_configured') when OPENROUTER_API_KEY is missing", async () => {
    delete process.env.OPENROUTER_API_KEY;

    const err = await extractFromOcr(okOcr()).catch((e) => e);

    expect(err).toBeInstanceOf(AiExtractError);
    expect(err.code).toBe("not_configured");
    // Never made it to messages.parse.
    expect(anthropic.parse).not.toHaveBeenCalled();
  });

  it("throws AiExtractError('parse_failed') when Claude returns no parsed_output", async () => {
    anthropic.parse.mockResolvedValue({ parsed_output: null });

    const err = await extractFromOcr(okOcr()).catch((e) => e);

    expect(err).toBeInstanceOf(AiExtractError);
    expect(err.code).toBe("parse_failed");
  });

  it("maps Anthropic.RateLimitError to AiExtractError('rate_limited')", async () => {
    anthropic.parse.mockRejectedValue(new anthropic.RateLimitError("slow down"));

    const err = await extractFromOcr(okOcr()).catch((e) => e);

    expect(err).toBeInstanceOf(AiExtractError);
    expect(err.code).toBe("rate_limited");
  });

  it("maps Anthropic.BadRequestError to AiExtractError('bad_input')", async () => {
    anthropic.parse.mockRejectedValue(new anthropic.BadRequestError("bad"));

    const err = await extractFromOcr(okOcr()).catch((e) => e);

    expect(err).toBeInstanceOf(AiExtractError);
    expect(err.code).toBe("bad_input");
  });

  it("maps a generic Anthropic.APIError to AiExtractError('upstream_error')", async () => {
    anthropic.parse.mockRejectedValue(new anthropic.APIError("upstream 500"));

    const err = await extractFromOcr(okOcr()).catch((e) => e);

    expect(err).toBeInstanceOf(AiExtractError);
    expect(err.code).toBe("upstream_error");
  });

  it("maps unknown throws to AiExtractError('unknown')", async () => {
    anthropic.parse.mockRejectedValue(new Error("network dropped"));

    const err = await extractFromOcr(okOcr()).catch((e) => e);

    expect(err).toBeInstanceOf(AiExtractError);
    expect(err.code).toBe("unknown");
  });
});
