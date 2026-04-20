/**
 * Shared Anthropic SDK mock types for route tests (BND-010).
 *
 * Vitest hoists `vi.mock(...)` and `vi.hoisted(...)` factories to the top
 * of the test file, and they run BEFORE any import has been initialized.
 * That means a factory cannot call an imported helper function. So this
 * module intentionally does NOT export a "makeHandle" factory — it only
 * exports the handle type and an inline snippet for copy-paste into test
 * files.
 *
 * Every test file that needs to mock the Anthropic SDK writes this at the
 * top of the file:
 *
 *   const anthropic = vi.hoisted(() => {
 *     class APIError extends Error {}
 *     class RateLimitError extends APIError {}
 *     class BadRequestError extends APIError {}
 *     return {
 *       ctor: vi.fn(),
 *       parse: vi.fn(),
 *       create: vi.fn(),
 *       APIError, RateLimitError, BadRequestError,
 *     };
 *   });
 *
 *   vi.mock("@anthropic-ai/sdk", () => ({
 *     default: class Anthropic {
 *       messages = { parse: anthropic.parse, create: anthropic.create };
 *       static APIError = anthropic.APIError;
 *       static RateLimitError = anthropic.RateLimitError;
 *       static BadRequestError = anthropic.BadRequestError;
 *       constructor(...args: unknown[]) {
 *         anthropic.ctor(...args);
 *       }
 *     },
 *   }));
 *
 *   vi.mock("@anthropic-ai/sdk/helpers/zod", () => ({
 *     zodOutputFormat: () => ({ type: "json_schema", schema: {} }),
 *   }));
 *
 * The shared type `AnthropicMockHandle` lets test helpers declare the
 * handle's shape without duplicating it.
 */
import type { Mock } from "vitest";

export type AnthropicMockHandle = {
  /** Recorded constructor invocations of `new Anthropic(...)`. */
  ctor: Mock;
  /** Stub for `client.messages.parse(...)`. */
  parse: Mock;
  /** Stub for `client.messages.create(...)` (used by /api/scan-bottle). */
  create: Mock;
  /** Real Error subclasses, suitable for `throw new handle.APIError(...)`. */
  APIError: new (message?: string) => Error;
  RateLimitError: new (message?: string) => Error;
  BadRequestError: new (message?: string) => Error;
};
