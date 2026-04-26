/**
 * BND-039 — Claude inference fallback for the rule engine.
 *
 * The rule engine (rules.ts + enrich.ts) covers the major varietals
 * (Cab, Pinot, Chardonnay, etc.) but doesn't know about Champagne,
 * vintage Port, sherry, dessert wines, or obscure grapes (Txakoli,
 * Schiava, etc.). For those, we ask Claude to estimate based on
 * producer + name + vintage + varietal + region.
 *
 * Tradeoff vs the rule engine:
 *   • Rule: free, ~5ms, deterministic, ~80% varietal coverage.
 *   • Claude: ~$0.001/call, ~3-5s, ~95% coverage on obscure wines,
 *     produces an actual review excerpt the user can read.
 *
 * Failure modes (returns null gracefully):
 *   • ANTHROPIC_API_KEY not set → throw on first call (logged once)
 *   • Network/timeout → null + Sentry tag rateLimited:false, parseError:false
 *   • Rate limit 429/529 → null + Sentry tag rateLimited:true
 *   • JSON parse failure → null + Sentry tag parseError:true
 *   • Schema validation failure → null + Sentry tag parseError:true
 *
 * The bulk-enrich route uses these nulls to OMIT failed wines from the
 * batch RPC payload — partial success is preferred over all-or-nothing.
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
const MAX_TOKENS = 400;
const SYSTEM_PROMPT = `You are a sommelier estimating a wine's optimal drinking window. Given a wine's producer, name, vintage, varietal, and region, return a JSON object with these fields:

{
  "drinkWindowStart": <year, integer>,
  "drinkWindowEnd": <year, integer>,
  "peakYear": <year, integer>,
  "reviewExcerpt": "<≤200 char tasting-note style sentence describing the wine's expected character at peak>"
}

Use your knowledge of:
- The producer's house style (oxidative vs reductive winemaking, oak regimen, etc.)
- The vintage's reputation (warm/cool year, classified-growth ratings)
- The varietal's aging curve (Cab/Nebbiolo long, Pinot moderate, Sauv Blanc short)
- The region's terroir (Bordeaux structured, Burgundy delicate, Napa ripe)

Conservative when uncertain — narrower windows are better than wildly wrong ones.

If the wine is too obscure to estimate confidently, OR if it's a non-vintage wine where drinking-window doesn't apply (most NV Champagnes, fortified wines for immediate consumption), return null fields:
{ "drinkWindowStart": null, "drinkWindowEnd": null, "peakYear": null, "reviewExcerpt": null }

Return ONLY the JSON object. No prose, no markdown fences.`;

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
};

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
      max_tokens: MAX_TOKENS,
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
    // Distinguish rate-limit from other errors so the bulk enricher can
    // surface a useful message ("Anthropic rate-limited; try again in a
    // few minutes") vs a generic "enrichment failed".
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

  // Parse + validate. The system prompt asks for JSON-only, but models
  // sometimes wrap in fences anyway. Strip them defensively.
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
    // Claude isn't asked about serving temp — that stays as the rule
    // engine's responsibility. Returning null here means the caller will
    // not overwrite a previously-set serving_temp on the row.
    servingTempMin: null,
    servingTempMax: null,
    servingTempLabel: null,
  };
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
    return obj.reviewExcerpt === null || typeof obj.reviewExcerpt === "string";
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

  return true;
}

/**
 * Exported for tests so we don't have to mock the Anthropic SDK to test
 * validation logic.
 */
export const __validateForTests = validateClaudeResponse;
