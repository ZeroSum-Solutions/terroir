/**
 * `extractFromImages` — invoice structuring straight from the photo, used when
 * Azure OCR is unavailable (see src/domains/scanning/invoice-extraction-stage.ts).
 * Same hoisted-SDK-mock pattern as ai-extract.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const anthropic = vi.hoisted(() => {
  class AnthropicError extends Error {}
  class APIError extends AnthropicError {}
  class RateLimitError extends APIError {}
  class BadRequestError extends APIError {}
  return { parse: vi.fn(), AnthropicError, APIError, RateLimitError, BadRequestError };
});
vi.mock("@anthropic-ai/sdk", () => ({
  default: class Anthropic {
    messages = { parse: anthropic.parse };
    static AnthropicError = anthropic.AnthropicError;
    static APIError = anthropic.APIError;
    static RateLimitError = anthropic.RateLimitError;
    static BadRequestError = anthropic.BadRequestError;
  },
}));
vi.mock("@anthropic-ai/sdk/helpers/zod", () => ({
  zodOutputFormat: () => ({ type: "json_schema", schema: {} }),
}));

const { extractFromImages, extractFromOcr, AiExtractError } = await import("./ai-extract");
const { __resetAnthropicClientForTests } = await import("@/lib/ai/anthropic-client");

const happy = () => ({
  parsed_output: {
    distributor: "Southern Glazer's",
    invoiceNumber: "4471023",
    invoiceDate: "2026-08-28",
    lineItems: [
      { name: "Cabernet Sauvignon", producer: "Austin Hope", vintage: 2021, varietal: "Cabernet Sauvignon", region: "Paso Robles", qty: 6, unitCost: 38, lineTotal: 228, currency: "USD", format: "750ml", confidence: 0.95, lowFields: [] },
    ],
  },
});
const jpeg = { buffer: Buffer.from("jpeg-bytes"), mimeType: "image/jpeg" };
const png = { buffer: Buffer.from("png-bytes"), mimeType: "image/png" };
const pdf = { buffer: Buffer.from("%PDF-1.4"), mimeType: "application/pdf" };

describe("extractFromImages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetAnthropicClientForTests();
    process.env.OPENROUTER_API_KEY = "sk-test";
  });

  it("sends every page as an image block, then the instruction, under the invoice system prompt", async () => {
    anthropic.parse.mockResolvedValue(happy());
    const parsed = await extractFromImages([jpeg, png]);
    expect(parsed.lineItems).toHaveLength(1);
    const args = anthropic.parse.mock.calls[0]![0];
    expect(args.model).toBe("anthropic/claude-sonnet-5");
    expect(args.max_tokens).toBe(16000);
    expect(args.system).toContain("invoice");
    const content = args.messages[0].content;
    expect(content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.buffer.toString("base64") } });
    expect(content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: png.buffer.toString("base64") } });
    expect(content[2].type).toBe("text");
  });

  it("sends a PDF as a document block", async () => {
    anthropic.parse.mockResolvedValue(happy());
    await extractFromImages([pdf]);
    const content = anthropic.parse.mock.calls[0]![0].messages[0].content;
    expect(content[0]).toEqual({ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.buffer.toString("base64") } });
  });

  it("honours the profile passed for the arithmetic retry", async () => {
    anthropic.parse.mockResolvedValue(happy());
    await extractFromImages([jpeg], { model: "anthropic/claude-sonnet-5", effort: "high", maxTokens: 24000 });
    const args = anthropic.parse.mock.calls[0]![0];
    expect(args.max_tokens).toBe(24000);
    expect(args.output_config.effort).toBe("high");
  });

  it("refuses HEIC/HEIF as bad_input before spending a call: vision models cannot read them", async () => {
    const err = await extractFromImages([{ buffer: Buffer.from("x"), mimeType: "image/heic" }]).catch((e) => e);
    expect(err).toBeInstanceOf(AiExtractError);
    expect(err.code).toBe("bad_input");
    expect(anthropic.parse).not.toHaveBeenCalled();
  });

  it("maps the SDK's structured-output parse failure to parse_failed, not unknown", async () => {
    anthropic.parse.mockRejectedValue(new anthropic.AnthropicError("Failed to parse structured output: invalid_value"));
    const err = await extractFromImages([jpeg]).catch((e) => e);
    expect(err).toBeInstanceOf(AiExtractError);
    expect(err.code).toBe("parse_failed");
  });
});

describe("extractFromOcr shares the mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetAnthropicClientForTests();
    process.env.OPENROUTER_API_KEY = "sk-test";
  });

  it("maps the SDK's structured-output parse failure to parse_failed", async () => {
    anthropic.parse.mockRejectedValue(new anthropic.AnthropicError("Failed to parse structured output: invalid_value"));
    const err = await extractFromOcr({ rawText: "text", tables: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(AiExtractError);
    expect(err.code).toBe("parse_failed");
  });
});
