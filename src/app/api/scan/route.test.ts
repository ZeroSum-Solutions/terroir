import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

/**
 * /api/scan route tests.
 *
 * Focus: requireMembership (not requireAuth) gates the endpoint, and an
 * unauthenticated caller receives a 401 without ever triggering the paid
 * Azure OCR or Anthropic calls. (ARCH-001)
 */

// requireMembership stub
const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));

// Paid upstreams — these MUST NOT be called on a 401.
const mockAnalyzeInvoice = vi.fn();
vi.mock("@/lib/scanner/azure", () => ({
  analyzeInvoice: (...args: unknown[]) => mockAnalyzeInvoice(...args),
}));

// Anthropic SDK is imported as a default class — stub the constructor so the
// test can assert it was never instantiated on the 401 path.
const mockAnthropicCtor = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  class AnthropicError extends Error {}
  return {
    default: class Anthropic {
      constructor(...args: unknown[]) {
        mockAnthropicCtor(...args);
      }
      messages = { parse: vi.fn() };
      static RateLimitError = AnthropicError;
      static BadRequestError = AnthropicError;
      static APIError = AnthropicError;
    },
  };
});

// zodOutputFormat is pulled in at module init — stub it to a no-op.
vi.mock("@anthropic-ai/sdk/helpers/zod", () => ({
  zodOutputFormat: () => ({ type: "json_schema", schema: {} }),
}));

const { POST } = await import("./route");

function makeFormRequest(formData: FormData) {
  return new Request("http://localhost/api/scan", {
    method: "POST",
    body: formData,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

describe("POST /api/scan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Keep the env checks happy so the 401 path is reached cleanly.
    process.env.AZURE_DOC_INTELLIGENCE_ENDPOINT = "https://example.invalid";
    process.env.AZURE_DOC_INTELLIGENCE_KEY = "test-key";
    process.env.ANTHROPIC_API_KEY = "sk-test";
  });

  it("returns 401 when the caller is unauthenticated — and never calls Azure or Anthropic", async () => {
    mockRequireMembership.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );

    const fd = new FormData();
    // A file is present so we can be sure the 401 fires BEFORE body parsing.
    fd.append("file", new File(["abc"], "x.pdf", { type: "application/pdf" }));

    const res = await POST(makeFormRequest(fd));

    expect(res).toBeInstanceOf(NextResponse);
    expect(res.status).toBe(401);
    expect(mockAnalyzeInvoice).not.toHaveBeenCalled();
    expect(mockAnthropicCtor).not.toHaveBeenCalled();
  });

  it("returns 403 when the user is authed but has no membership", async () => {
    mockRequireMembership.mockResolvedValue(
      NextResponse.json({ error: "No restaurant membership found." }, { status: 403 }),
    );

    const fd = new FormData();
    fd.append("file", new File(["abc"], "x.pdf", { type: "application/pdf" }));

    const res = await POST(makeFormRequest(fd));

    expect(res.status).toBe(403);
    expect(mockAnalyzeInvoice).not.toHaveBeenCalled();
    expect(mockAnthropicCtor).not.toHaveBeenCalled();
  });
});
