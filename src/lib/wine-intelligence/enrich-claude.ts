/**
 * BND-039 — Claude inference fallback for the rule engine.
 *
 * The rule engine (rules.ts + enrich.ts) covers the major varietals
 * (Cab, Pinot, Chardonnay, etc.) but doesn't know about Champagne,
 * vintage Port, sherry, dessert wines, or obscure grapes (Txakoli,
 * Schiava, etc.). For those, we ask Claude to estimate based on
 * producer + name + vintage + varietal + region.
 *
 * BND-262 (feature #75) — Batched Claude calls.
 * Instead of one Claude API call per wine (O(n) token overhead, n round
 * trips), send all candidate wines in a single Claude call and parse the
 * JSON array response. This reduces cost by sharing the system prompt
 * and avoids per-wine connection overhead.
 *
 * Tradeoff vs the rule engine:
 *   • Rule: free, ~5ms, deterministic, ~80% varietal coverage.
 *   • Claude: ~$0.001/call, ~3-5s, ~95% coverage on obscure wines,
 *     produces an actual review excerpt the user can read.
 *
 * Failure modes:
 *   • ANTHROPIC_API_KEY not set → throw on first call (logged once)
 *   • Network/timeout → results array of nulls + Sentry
 *   • Rate limit 429/529 → results array of nulls + Sentry tag rateLimited:true
 *   • JSON parse failure → results array of nulls + Sentry tag parseError:true
 */

import * as Sentry from "@sentry/nextjs";
import { getAnthropicClient } from "@/lib/ai/anthropic-client";
import type { EnrichmentResult } from "./enrich";

/**
 * Pinned to the same model family the scan/extract routes use.
 * Sonnet is the right tier for this — drink-window inference is
 * judgment + general knowledge, not reasoning. Don't pay for Opus.
 */
const MODEL = "claude-sonnet-4-5-20250929";

/** Per-wine max tokens for the single-wine function (backwards compat). */
const MAX_TOKENS_SINGLE = 400;

/** Per-wine token budget multiplier for batched calls. */
const MAX_TOKENS_PER_WINE = 300;

export type WineForClaude = {
  producer: string;
  name: string;
  vintage: number | null;
  varietal: string | null;
  region: string | null;
  country: string | null;
};

type ClaudeResponse = {
  drinkWindowStart: number | null;
  drinkWindowEnd: number | null;
  peakYear: number | null;
  reviewExcerpt: string | null;
  decantMinutes?: number | null;
};

// ── Single-wine (backwards compat) ──

const SYSTEM_PROMPT = `You are a sommelier estimating a wine's optimal drinking window. Given a wine's producer, name, vintage, varietal, and region, return a JSON object with these fields:

{
  "drinkWindowStart": <year, integer>,
  "drinkWindowEnd": <year, integer>,
  "peakYear": <year, integer>,
  "reviewExcerpt": "<≤200 char tasting-note style sentence describing the wine's expected character at peak>",
  "decantMinutes": <integer, minutes to decant before serving, 0 if no decanting needed>
}

Use your knowledge of:
- The producer's house style (oxidative vs reductive winemaking, oak regimen, etc.)
- The vintage's reputation (warm/cool year, classified-growth ratings)
- The varietal's aging curve (Cab/Nebbiolo long, Pinot moderate, Sauv Blanc short)
- The region's terroir (Bordeaux structured, Burgundy delicate, Napa ripe)

Decant guidelines: young, tannic reds (Cab, Nebbiolo, Syrah) need 60-120 min; lighter reds (Pinot Noir, Gamay) 0-30 min; most whites 0 min; sparkling 0 min; aged wines need less decanting than young ones. Conservative when uncertain — narrower windows are better than wildly wrong ones.

If the wine is too obscure to estimate confidently, OR if it's a non-vintage wine where drinking-window doesn't apply (most NV Champagnes, fortified wines for immediate consumption), return null fields:
{ "drinkWindowStart": null, "drinkWindowEnd": null, "peakYear": null, "reviewExcerpt": null }

Return ONLY the JSON object. No prose, no markdown fences.`;

/**
 * Call Claude to infer drink window for a single wine. Returns an
 * `EnrichmentResult`-shaped value with `ratingSource: 'claude_inference'`
 * on success, or null on any failure.
 *
 * The function intentionally does NOT throw — bulk enrichment treats
 * null as "skip this wine" so one bad call doesn't abort the batch.
 *
 * Note: `servingTemp*` fields stay null from this fallback. The rule
 * engine handles serving temp; Claude is asked only about drink windows
 * (a narrower task gets better answers).
 */
export async function enrichWineWithClaude(
  wine: WineForClaude,
): Promise<EnrichmentResult | null> {
  // Vintage required — non-vintage wines have no meaningful drink window
  // and the prompt's null-on-NV branch handles that anyway, but skipping
  // saves a token spend.
  if (wine.vintage == null) return null;

  const userMessage = formatWineForPrompt(wine);

  let raw: string;
  try {
    const client = getAnthropicClient();
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS_SINGLE,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });
    const block = response.content[0];
    if (block?.type !== "text") {
      Sentry.captureMessage("Claude response had no text block", {
        level: "warning",
        tags: { surface: "wines-enrich-claude", parseError: "true" },
      });
      return null;
    }
    raw = block.text.trim();
  } catch (err) {
    const status = (err as { status?: number })?.status;
    const rateLimited = status === 429 || status === 529;
    Sentry.captureException(err, {
      tags: {
        surface: "wines-enrich-claude",
        rateLimited: String(rateLimited),
        parseError: "false",
      },
      extra: { wine: { producer: wine.producer, name: wine.name, vintage: wine.vintage } },
    });
    return null;
  }

  return parseClaudeResponse(raw);
}

// ── Batched Claude (BND-262) ──

const BATCH_SYSTEM_PROMPT = `You are a sommelier estimating optimal drinking windows and decant times for a batch of wines. You will receive a list of wines, each with producer, name, vintage, varietal, and region. Return a JSON array with one object per wine, in the same order, with these fields:

{
  "drinkWindowStart": <year, integer>,
  "drinkWindowEnd": <year, integer>,
  "peakYear": <year, integer>,
  "reviewExcerpt": "<≤200 char tasting-note style sentence describing the wine's expected character at peak>",
  "decantMinutes": <integer, minutes to decant before serving, 0 if no decanting needed>
}

Use your knowledge of:
- The producer's house style (oxidative vs reductive winemaking, oak regimen, etc.)
- The vintage's reputation (warm/cool year, classified-growth ratings)
- The varietal's aging curve (Cab/Nebbiolo long, Pinot moderate, Sauv Blanc short)
- The region's terroir (Bordeaux structured, Burgundy delicate, Napa ripe)

Decant guidelines: young, tannic reds (Cab, Nebbiolo, Syrah) need 60-120 min; lighter reds (Pinot Noir, Gamay) 0-30 min; most whites 0 min; sparkling 0 min.

Conservative when uncertain — narrower windows are better than wildly wrong ones.

If a wine is too obscure to estimate confidently, OR if it's a non-vintage wine where drinking-window doesn't apply, return null fields for that wine:
{ "drinkWindowStart": null, "drinkWindowEnd": null, "peakYear": null, "reviewExcerpt": null }

Return ONLY the JSON array. No prose, no markdown fences.`;

/**
 * BND-262 — Batched Claude enrichment.
 *
 * Send all candidate wines in a single Claude API call. Returns an array
 * of `EnrichmentResult | null` in the same order as the input wines.
 *
 * The single call shares the system prompt across all wines, reducing
 * per-wine token overhead and connection cost. A batch of 50 wines
 * costs ~1 API call instead of 50.
 *
 * On any failure (network, rate limit, parse error), all wines get null
 * — the caller should retry or skip.
 */
export async function enrichWinesWithClaudeBatch(
  wines: WineForClaude[],
): Promise<(EnrichmentResult | null)[]> {
  if (wines.length === 0) return [];

  const userMessage = wines.map((w, i) =>
    `${i + 1}. ${formatWineForPrompt(w)}`
  ).join("\n\n");

  let raw: string;
  try {
    const client = getAnthropicClient();
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: Math.max(1024, wines.length * MAX_TOKENS_PER_WINE),
      system: BATCH_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });
    const block = response.content[0];
    if (block?.type !== "text") {
      Sentry.captureMessage("Batched Claude response had no text block", {
        level: "warning",
        tags: { surface: "wines-enrich-claude-batch", parseError: "true" },
        extra: { wineCount: wines.length },
      });
      return wines.map(() => null);
    }
    raw = block.text.trim();
  } catch (err) {
    const status = (err as { status?: number })?.status;
    const rateLimited = status === 429 || status === 529;
    Sentry.captureException(err, {
      tags: {
        surface: "wines-enrich-claude-batch",
        rateLimited: String(rateLimited),
        parseError: "false",
      },
      extra: { wineCount: wines.length },
    });
    return wines.map(() => null);
  }

  // Parse the JSON array response.
  let parsedArray: unknown[];
  try {
    const cleaned = raw
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    parsedArray = JSON.parse(cleaned);
    if (!Array.isArray(parsedArray)) {
      throw new Error("Response is not a JSON array.");
    }
  } catch (err) {
    Sentry.captureException(err, {
      tags: { surface: "wines-enrich-claude-batch", parseError: "true" },
      extra: { rawResponse: raw.slice(0, 1000), wineCount: wines.length },
    });
    return wines.map(() => null);
  }

  // Validate and convert each response. Pad with nulls if Claude returned fewer.
  const results: (EnrichmentResult | null)[] = [];
  for (let i = 0; i < wines.length; i++) {
    if (i >= parsedArray.length) {
      results.push(null);
      continue;
    }
    const parsed = parseClaudeResponseFromObject(parsedArray[i]);
    if (!parsed) {
      Sentry.captureMessage("Batched Claude response item failed validation", {
        level: "warning",
        tags: { surface: "wines-enrich-claude-batch", parseError: "true" },
        extra: { index: i, item: JSON.stringify(parsedArray[i]).slice(0, 200) },
      });
      results.push(null);
      continue;
    }
    results.push({
      drinkWindowStart: parsed.drinkWindowStart,
      drinkWindowEnd: parsed.drinkWindowEnd,
      peakYear: parsed.peakYear,
      ratingSource: parsed.drinkWindowStart != null ? "claude_inference" : null,
      reviewExcerpt: parsed.reviewExcerpt,
      servingTempMin: null,
      servingTempMax: null,
      servingTempLabel: null,
      decantMinutes: parsed.decantMinutes ?? null,
    });
  }

  return results;
}

// ── Shared helpers ──

function parseClaudeResponse(raw: string): EnrichmentResult | null {
  let parsed: ClaudeResponse;
  try {
    const cleaned = raw
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    parsed = JSON.parse(cleaned) as ClaudeResponse;
  } catch (err) {
    Sentry.captureException(err, {
      tags: { surface: "wines-enrich-claude", parseError: "true" },
      extra: { rawResponse: raw.slice(0, 500) },
    });
    return null;
  }

  if (!validateClaudeResponse(parsed)) {
    Sentry.captureMessage("Claude response failed schema validation", {
      level: "warning",
      tags: { surface: "wines-enrich-claude", parseError: "true" },
      extra: { parsed },
    });
    return null;
  }

  return {
    drinkWindowStart: parsed.drinkWindowStart,
    drinkWindowEnd: parsed.drinkWindowEnd,
    peakYear: parsed.peakYear,
    ratingSource: parsed.drinkWindowStart != null ? "claude_inference" : null,
    reviewExcerpt: parsed.reviewExcerpt,
    servingTempMin: null,
    servingTempMax: null,
    servingTempLabel: null,
    decantMinutes: parsed.decantMinutes ?? null,
  };
}

function parseClaudeResponseFromObject(obj: unknown): ClaudeResponse | null {
  if (!validateClaudeResponse(obj)) return null;
  return obj as ClaudeResponse;
}

function formatWineForPrompt(wine: WineForClaude): string {
  const parts = [
    `Producer: ${wine.producer}`,
    `Name: ${wine.name}`,
    `Vintage: ${wine.vintage ?? "NV"}`,
  ];
  if (wine.varietal) parts.push(`Varietal: ${wine.varietal}`);
  if (wine.region) parts.push(`Region: ${wine.region}`);
  if (wine.country) parts.push(`Country: ${wine.country}`);
  return parts.join("\n");
}

/**
 * Verify Claude's JSON matches the expected shape. We accept all-null
 * (the "too obscure to estimate" branch) and well-formed year tuples.
 *
 * Years must be 1900-2100. drinkWindowStart ≤ peakYear ≤ drinkWindowEnd.
 * reviewExcerpt ≤ 240 chars.
 */
function validateClaudeResponse(r: unknown): r is ClaudeResponse {
  if (typeof r !== "object" || r === null) return false;
  const obj = r as Record<string, unknown>;

  const hasField = (k: string) => Object.prototype.hasOwnProperty.call(obj, k);
  if (!hasField("drinkWindowStart") || !hasField("drinkWindowEnd")) return false;
  if (!hasField("peakYear") || !hasField("reviewExcerpt")) return false;

  // All-null is valid (the unknown-wine branch).
  if (
    obj.drinkWindowStart === null &&
    obj.drinkWindowEnd === null &&
    obj.peakYear === null
  ) {
    return (obj.reviewExcerpt === null || typeof obj.reviewExcerpt === "string") &&
      (!hasField("decantMinutes") ||
        obj.decantMinutes === null ||
        (typeof obj.decantMinutes === "number" &&
          Number.isInteger(obj.decantMinutes) &&
          obj.decantMinutes >= 0 &&
          obj.decantMinutes <= 240));
  }

  // Otherwise all year fields must be valid integers in range.
  const start = obj.drinkWindowStart;
  const end = obj.drinkWindowEnd;
  const peak = obj.peakYear;
  if (typeof start !== "number" || !Number.isInteger(start)) return false;
  if (typeof end !== "number" || !Number.isInteger(end)) return false;
  if (peak !== null && (typeof peak !== "number" || !Number.isInteger(peak))) return false;
  if (start < 1900 || start > 2100) return false;
  if (end < 1900 || end > 2100) return false;
  if (start > end) return false;
  if (typeof peak === "number" && (peak < start || peak > end)) return false;
  if (
    obj.reviewExcerpt !== null &&
    (typeof obj.reviewExcerpt !== "string" || obj.reviewExcerpt.length > 240)
  ) {
    return false;
  }
  if (
    hasField("decantMinutes") &&
    obj.decantMinutes !== null &&
    (typeof obj.decantMinutes !== "number" || !Number.isInteger(obj.decantMinutes) || obj.decantMinutes < 0 || obj.decantMinutes > 240)
  ) {
    return false;
  }

  return true;
}

/**
 * Exported for tests so we don't have to mock the Anthropic SDK to test
 * validation logic.
 */
export const __validateForTests = validateClaudeResponse;
