import { beforeEach, describe, expect, it, vi } from "vitest";

const { messagesCreate, captureException, captureMessage } = vi.hoisted(() => ({
  messagesCreate: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock("@/lib/ai/anthropic-client", () => ({
  getAnthropicClient: () => ({ messages: { create: messagesCreate } }),
}));
vi.mock("@sentry/nextjs", () => ({
  captureException,
  captureMessage,
}));

const {
  enrichWineWithClaude,
  enrichWinesWithClaudeBatch,
  WineEnrichmentProviderError,
} = await import("./enrich-claude");

const WINE = {
  producer: "Domaine Test",
  name: "Reserve",
  vintage: 2019,
  varietal: "Unknown",
  region: "Unknown",
  country: null,
};

describe("Claude enrichment worker failure policy", () => {
  beforeEach(() => vi.clearAllMocks());

  it("preserves the synchronous fail-open behavior", async () => {
    messagesCreate.mockRejectedValue({ status: 429 });

    await expect(enrichWinesWithClaudeBatch([WINE])).resolves.toEqual([null]);
    await expect(enrichWineWithClaude(WINE)).resolves.toBeNull();
  });

  it("makes transient provider failures retryable for the durable worker", async () => {
    messagesCreate.mockRejectedValue({ status: 429 });

    await expect(
      enrichWinesWithClaudeBatch([WINE], { throwOnFailure: true }),
    ).rejects.toMatchObject({
      code: "wine_enrichment_provider_unavailable",
      retryable: true,
    });
  });

  it("makes invalid provider configuration terminal for the durable worker", async () => {
    messagesCreate.mockRejectedValue({ status: 401 });

    await expect(
      enrichWineWithClaude(WINE, { throwOnFailure: true }),
    ).rejects.toMatchObject({
      code: "wine_enrichment_provider_configuration",
      retryable: false,
    });
  });

  it("retries malformed single-wine responses in strict worker mode", async () => {
    messagesCreate.mockResolvedValue({
      content: [{ type: "text", text: "not-json" }],
    });

    await expect(
      enrichWineWithClaude(WINE, { throwOnFailure: true }),
    ).rejects.toMatchObject({
      code: "wine_enrichment_provider_unavailable",
      retryable: true,
    });
  });

  it("keeps worker telemetry free of wine fields and provider bodies", async () => {
    messagesCreate.mockRejectedValue({
      status: 429,
      response: { body: "provider-secret-body" },
    });

    await expect(
      enrichWineWithClaude(WINE, { throwOnFailure: true }),
    ).rejects.toBeInstanceOf(WineEnrichmentProviderError);

    const telemetry = JSON.stringify([
      captureException.mock.calls,
      captureMessage.mock.calls,
    ]);
    expect(telemetry).not.toContain(WINE.producer);
    expect(telemetry).not.toContain(WINE.name);
    expect(telemetry).not.toContain("provider-secret-body");
  });

  it("passes the worker abort signal to the provider and preserves its reason", async () => {
    const controller = new AbortController();
    const reason = new Error("stop");
    messagesCreate.mockImplementation(
      async (_body: unknown, options: { signal?: AbortSignal }) => {
        expect(options.signal).toBe(controller.signal);
        controller.abort(reason);
        throw new DOMException("aborted", "AbortError");
      },
    );

    await expect(
      enrichWineWithClaude(WINE, {
        signal: controller.signal,
        throwOnFailure: true,
      }),
    ).rejects.toBe(reason);
  });

  it("exports a typed error boundary without leaking provider responses", () => {
    const error = new WineEnrichmentProviderError(
      "wine_enrichment_provider_unavailable",
      true,
    );
    expect(error.message).toBe("Wine enrichment provider failed");
  });
});
