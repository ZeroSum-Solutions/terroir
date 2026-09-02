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
    process.env.OPENROUTER_API_KEY = "test-key";
    delete process.env.ANTHROPIC_API_KEY;
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

  it("points the SDK at OpenRouter with maxRetries: 2 and timeout: 100_000", () => {
    getAnthropicClient();
    expect(constructorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "test-key",
        baseURL: "https://openrouter.ai/api",
        maxRetries: 2,
        timeout: 100_000,
      }),
    );
  });

  it("throws a clear error when OPENROUTER_API_KEY is not set", () => {
    delete process.env.OPENROUTER_API_KEY;
    expect(() => getAnthropicClient()).toThrow(/OPENROUTER_API_KEY/);
    // And nothing was constructed.
    expect(constructorSpy).not.toHaveBeenCalled();
  });
});

describe("getAnthropicClient — provider cutover", () => {
  beforeEach(() => {
    constructorSpy.mockClear();
    __resetAnthropicClientForTests();
  });

  it("ignores a direct Anthropic key: OpenRouter is the only provider", () => {
    delete process.env.OPENROUTER_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-be-used";
    expect(() => getAnthropicClient()).toThrow(/OPENROUTER_API_KEY/);
    expect(constructorSpy).not.toHaveBeenCalled();
    delete process.env.ANTHROPIC_API_KEY;
  });
});
