/**
 * Module-scoped model-provider client singleton.
 *
 * The SDK is Anthropic's; the wire is OpenRouter's. OpenRouter serves an
 * Anthropic-compatible Messages endpoint, so the same `messages.parse` /
 * `messages.create` calls — structured outputs via `output_config.format`,
 * `effort`, image blocks — reach any model in the OpenRouter catalogue by its
 * namespaced id (`anthropic/claude-sonnet-5`, `openai/gpt-5-nano`, …).
 * Verified live on 2026-09-01 across five models plus an image call before
 * the cutover; the ids themselves live in `@/lib/ai/models`.
 *
 * Only `OPENROUTER_API_KEY` is read. A direct `ANTHROPIC_API_KEY` is
 * deliberately ignored so there is exactly one billing path and one place a
 * model gets named.
 *
 * Fixes INT-007 (code-council audit): routes used to construct a new
 * `Anthropic()` client per request with default retry/timeout settings.
 * Under a slow upstream the SDK's default retry budget is effectively
 * unbounded (exponential backoff × many retries), so a single bad
 * request could sit hanging until the client disconnected. Pinning
 * `maxRetries: 2` + `timeout: 100_000` gives us predictable p99 latency
 * and headroom to return a clean error within the route's
 * self-declared `maxDuration`.
 *
 * Cached at module scope so every import inside the same server process
 * reuses one client — on Railway that's the long-lived Node container,
 * so one warm client serves every request the instance ever handles.
 * The client is safe to share — it has no per-request state.
 */
import Anthropic from "@anthropic-ai/sdk";

/**
 * OpenRouter's API root. The SDK appends `/v1/messages` itself, so this must
 * NOT end in `/v1` — `https://openrouter.ai/api/v1` produces a 404 HTML page
 * from `/api/v1/v1/messages`.
 */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api";

/**
 * OpenRouter provider-routing preferences, injected into every Messages
 * request body (the SDK has no field for them).
 *
 * `require_parameters` restricts routing to upstream providers that support
 * every parameter in the request. Measured 2026-09-01: OpenRouter's default
 * routing put `anthropic/claude-sonnet-5` on "Claude Platform on AWS" and
 * `anthropic/claude-sonnet-4.5` on Amazon Bedrock — both fine, every probe
 * above ran there — but the Google Vertex endpoints for the same models do
 * NOT advertise structured outputs, and a fallback landing there would turn
 * `parsed_output` null (the invoice route's `parse_failed` 422) with nothing
 * in our code to blame. This keeps such an endpoint out of the rotation.
 */
export const OPENROUTER_PROVIDER_PREFERENCES = { require_parameters: true } as const;

/**
 * `fetch` wrapper that adds the provider preferences to Messages requests.
 * Only JSON bodies posted to `/v1/messages` are touched; anything else the
 * SDK sends goes through untouched.
 */
function openRouterFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.endsWith("/v1/messages") && typeof init?.body === "string") {
    try {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      return fetch(input, { ...init, body: JSON.stringify({ ...body, provider: OPENROUTER_PROVIDER_PREFERENCES }) });
    } catch {
      // Not JSON after all — send it as the SDK built it.
    }
  }
  return fetch(input, init);
}

/** Max retries the SDK will perform on transient errors (429/5xx). */
const ANTHROPIC_MAX_RETRIES = 2;

/**
 * Hard ceiling for a single model request, in ms.
 * Kept under the route-level `maxDuration = 120` in `/api/scan/route.ts`
 * so we always have headroom to return a clean error response before
 * our own declared ceiling fires. Railway imposes no platform-level
 * request timeout, so this ceiling is the only one in play.
 */
const ANTHROPIC_TIMEOUT_MS = 100_000;

let cachedClient: Anthropic | null = null;

/**
 * Return the shared client. Reads `OPENROUTER_API_KEY` on first call;
 * callers should still surface a friendly 500 when this throws.
 *
 * @throws {Error} when `OPENROUTER_API_KEY` is not set.
 */
export function getAnthropicClient(): Anthropic {
  if (cachedClient) return cachedClient;

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY missing");
  }

  cachedClient = new Anthropic({
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
    fetch: openRouterFetch,
    maxRetries: ANTHROPIC_MAX_RETRIES,
    timeout: ANTHROPIC_TIMEOUT_MS,
  });
  return cachedClient;
}

/** For tests only — forget the cached client so the next call re-reads env. */
export function __resetAnthropicClientForTests(): void {
  cachedClient = null;
}
