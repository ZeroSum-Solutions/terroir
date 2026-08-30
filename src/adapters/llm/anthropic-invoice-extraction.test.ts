// Contract test for the one piece of real logic this adapter owns — the
// rest of the module is a re-export of @/lib/scanner/ai-extract, which has
// its own suite.
//
// assertInvoiceExtractionConfigured exists so a caller can fail fast at a
// boundary instead of discovering a missing API key deep inside an
// extraction. That only holds if it actually propagates.
import { beforeEach, describe, expect, it, vi } from "vitest";

const getAnthropicClient = vi.fn();
vi.mock("@/lib/ai/anthropic-client", () => ({ getAnthropicClient: () => getAnthropicClient() }));

const { assertInvoiceExtractionConfigured } = await import("./anthropic-invoice-extraction");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("assertInvoiceExtractionConfigured", () => {
  it("returns quietly when the client can be constructed", () => {
    getAnthropicClient.mockReturnValue({});
    expect(() => assertInvoiceExtractionConfigured()).not.toThrow();
    expect(getAnthropicClient).toHaveBeenCalledTimes(1);
  });

  it("propagates the configuration error rather than swallowing it", () => {
    getAnthropicClient.mockImplementation(() => {
      throw new Error("ANTHROPIC_API_KEY is not set");
    });
    expect(() => assertInvoiceExtractionConfigured()).toThrow("ANTHROPIC_API_KEY is not set");
  });
});
