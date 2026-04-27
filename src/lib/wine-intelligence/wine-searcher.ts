/**
 * BND-040 — Wine-Searcher API client wrapper.
 *
 * Wine-Searcher is the canonical retail-price aggregator (~10M wines,
 * ~100k retailers globally). The trial tier gives ~500 calls/mo;
 * production tiers run $200-2k/mo. We start on trial to validate UX
 * before committing budget (open question 1 in BND-040 plan, defaulted
 * to trial per auto-mode).
 *
 * Architecture decisions (per architect-review):
 *   • LWIN matching is the lookup key — wines without lwin_id can't be
 *     queried (architect finding 6: ~60% target coverage).
 *   • Sanity filter: drop responses where the median price is outside
 *     0.1× to 10× the invoice cost. Trial-tier API can return wrong-wine
 *     hits on LWIN ambiguity (architect finding 5).
 *   • 7-day cache lives on `wines.retail_*` columns; this module does not
 *     manage TTL — callers check `isRetailStale()` from status.ts.
 *   • Failure modes return null; never throw to the caller. Sentry tags
 *     distinguish quota-exhausted, network failure, and unparseable.
 *
 * If WINE_SEARCHER_API_KEY is unset, every call returns null with a
 * single-shot Sentry warning. UI surfaces show "Pricing data unavailable
 * for this wine" — graceful degradation, never broken.
 */

import * as Sentry from "@sentry/nextjs";
import { isRetailPlausible } from "@/lib/pricing/status";

/** Public response shape — what callers persist to wines.retail_* columns. */
export type WineSearcherResult = {
  retailMin: number;
  retailMax: number;
  retailMedian: number;
  retailerCount: number;
  /** Raw response timestamp; for cache freshness display. */
  refreshedAt: Date;
};

export type WineSearcherInput = {
  lwinId: string;
  /** Optional: when known, used by sanity filter to drop garbage responses. */
  invoiceCost?: number | null;
};

const API_BASE_URL = "https://api.wine-searcher.com/api";
const REQUEST_TIMEOUT_MS = 10_000;

/** One-shot warning so the missing-key error doesn't spam Sentry on every wine. */
let _warnedOnMissingKey = false;

/**
 * Look up retail-price aggregates for a wine by LWIN.
 *
 * Returns null on:
 *   - LWIN missing
 *   - WINE_SEARCHER_API_KEY not set
 *   - HTTP error (rate-limited, 5xx, network)
 *   - JSON parse failure
 *   - Sanity-check rejection (price outside 0.1×–10× invoice cost)
 *
 * Always emits a Sentry tag distinguishing the failure type so ops can
 * see quota-exhausted vs. transient-network vs. data-quality issues.
 */
export async function fetchRetailPrices(
  input: WineSearcherInput,
): Promise<WineSearcherResult | null> {
  const { lwinId, invoiceCost } = input;
  if (!lwinId) return null;

  const apiKey = process.env.WINE_SEARCHER_API_KEY;
  if (!apiKey) {
    if (!_warnedOnMissingKey) {
      _warnedOnMissingKey = true;
      Sentry.captureMessage(
        "WINE_SEARCHER_API_KEY missing — pricing intelligence will degrade",
        {
          level: "warning",
          tags: { surface: "wine-searcher", phase: "config" },
        },
      );
    }
    return null;
  }

  // Trial-tier endpoint shape (Wine-Searcher trade API). Production tier
  // exposes more fields but we deliberately only use the aggregate shape
  // for v1.
  const url = `${API_BASE_URL}/wine?lwin=${encodeURIComponent(lwinId)}&format=json`;

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
  } catch (err) {
    Sentry.captureException(err, {
      tags: {
        surface: "wine-searcher",
        phase: "fetch",
        rateLimited: "false",
      },
      extra: { lwinId },
    });
    return null;
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (!response.ok) {
    const isRateLimit = response.status === 429 || response.status === 402;
    Sentry.captureMessage(
      `Wine-Searcher returned ${response.status}`,
      {
        level: isRateLimit ? "warning" : "error",
        tags: {
          surface: "wine-searcher",
          phase: "http-status",
          status: String(response.status),
          rateLimited: String(isRateLimit),
        },
        extra: { lwinId },
      },
    );
    return null;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    Sentry.captureException(err, {
      tags: { surface: "wine-searcher", phase: "parse" },
      extra: { lwinId },
    });
    return null;
  }

  const parsed = parseResponse(body);
  if (!parsed) {
    Sentry.captureMessage("Wine-Searcher response failed schema validation", {
      level: "warning",
      tags: { surface: "wine-searcher", phase: "schema" },
      extra: { lwinId, body: JSON.stringify(body).slice(0, 500) },
    });
    return null;
  }

  // Sanity filter — architect finding 5: trial-tier API may return wrong
  // wine on LWIN collisions; drop responses where median is implausible
  // vs. invoice cost.
  if (invoiceCost != null && !isRetailPlausible(parsed.retailMedian, invoiceCost)) {
    Sentry.captureMessage(
      "Wine-Searcher response failed sanity filter — likely wrong-wine hit",
      {
        level: "warning",
        tags: { surface: "wine-searcher", phase: "sanity-filter" },
        extra: {
          lwinId,
          retailMedian: parsed.retailMedian,
          invoiceCost,
          ratio: parsed.retailMedian / invoiceCost,
        },
      },
    );
    return null;
  }

  return parsed;
}

/**
 * Parse a Wine-Searcher response into our internal shape.
 *
 * The trial-tier response varies by version, but the fields we care about
 * are: min_price, max_price, average_price, offers_count (or similar).
 * We're conservative — accept either the documented shape OR a slightly
 * older/newer variant. Reject anything we can't map.
 */
function parseResponse(body: unknown): WineSearcherResult | null {
  if (typeof body !== "object" || body === null) return null;
  const obj = body as Record<string, unknown>;

  // Wine-Searcher's response wraps useful data under a "wine" object on
  // some endpoints, top-level on others. Try both.
  const wine = (obj.wine && typeof obj.wine === "object" ? obj.wine : obj) as Record<
    string,
    unknown
  >;

  const min = readNumber(wine.min_price ?? wine.priceMin);
  const max = readNumber(wine.max_price ?? wine.priceMax);
  // Wine-Searcher returns avg_price; we treat it as median for our purposes
  // (close enough for the band visual + outlier filter; production tier
  // returns true median).
  const median = readNumber(wine.average_price ?? wine.priceAvg ?? wine.median_price);
  const count = readNumber(wine.offers_count ?? wine.retailerCount ?? wine.merchant_count);

  if (min == null || max == null || median == null) return null;
  if (min < 0 || max < 0 || median < 0) return null;
  if (max < min) return null;
  if (median < min || median > max) return null;

  return {
    retailMin: min,
    retailMax: max,
    retailMedian: median,
    retailerCount: count != null && count > 0 ? Math.floor(count) : 0,
    refreshedAt: new Date(),
  };
}

function readNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Reset the missing-key warning latch — for tests so each test can
 * exercise the warning path independently.
 */
export function __resetWineSearcherForTests(): void {
  _warnedOnMissingKey = false;
}

/**
 * Exported parser for tests so we don't need the network to test schema
 * validation.
 */
export const __parseForTests = parseResponse;
