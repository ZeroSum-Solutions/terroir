import { beforeEach, describe, expect, it, vi } from "vitest";

// Spy on the Anthropic constructor BEFORE the module under test imports it.
// The SDK's default export is the Anthropic class, so we replace the default
// with a mock constructor that records its arguments and returns a sentinel.
const constructorSpy = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    constructor(options: unknown) {
      constructorSpy(options);
    }
  }
  return { default: MockAnthropic };
});

// Import AFTER the mock is registered.
import {
  __resetAnthropicClientForTests,
  getAnthropicClient,
} from "./anthropic-client";

describe("getAnthropicClient", () => {
  beforeEach(() => {
    constructorSpy.mockClear();
    __resetAnthropicClientForTests();
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  it("returns the same instance across repeat calls (singleton)", () => {
    const first = getAnthropicClient();
    const second = getAnthropicClient();
    const third = getAnthropicClient();
    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  it("constructs the underlying SDK exactly once even under many calls", () => {
    getAnthropicClient();
    getAnthropicClient();
    getAnthropicClient();
    expect(constructorSpy).toHaveBeenCalledTimes(1);
  });

  it("passes maxRetries: 2 and timeout: 100_000 to the SDK constructor", () => {
    getAnthropicClient();
    expect(constructorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "test-key",
        maxRetries: 2,
        timeout: 100_000,
      }),
    );
  });

  it("throws a clear error when ANTHROPIC_API_KEY is not set", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => getAnthropicClient()).toThrow(/ANTHROPIC_API_KEY/);
    // And nothing was constructed.
    expect(constructorSpy).not.toHaveBeenCalled();
  });
});
