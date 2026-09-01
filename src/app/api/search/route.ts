// P1 slice 1 — GET /api/search: the unified tier-1 endpoint
// (docs/plans/2026-08-31-unified-search-companion-and-canonical-facts.md
// D1 tier 1, D4, §7 P1).
//
// One query string in; one merged, ranked, honestly-deduped list out, over
// the tenant's cellar, the LWIN catalogue and the X-Wines corpus. The merge
// semantics live in src/lib/unified-search/merge.ts (unit-tested); this route
// is the wiring: gather hits, gather identity keys, degrade where the schema
// is younger than the code.
//
// Survival posture (AGENTS #7 — migrations do not ride deploys): this code
// will be live in production before 0145 (lwin_xwines_links) and 0146
// (xwines_search) are applied by hand. Every catalogue/links read therefore
// degrades — catalogue RPC down means cellar-only results, links read down
// means no dedupe claims — and the degradation is reported to Sentry, never
// swallowed and never a 500. A narrower true answer beats a broken search.
//
// The old surfaces' routes (/api/wines/search, /api/wines/lwin-search) are
// untouched: they die at feature parity (P1's deletion gate), not before.

import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { requireMembership } from "@/lib/api/auth";
import { parseQuery } from "@/lib/api/validation";
import {
  mergeUnifiedResults,
  type CellarHit,
  type LwinHit,
  type XwinesHit,
} from "@/lib/unified-search/merge";

export const runtime = "nodejs";

const QuerySchema = z.object({
  q: z.string().trim().max(200).default(""),
  scope: z.enum(["all", "cellar"]).default("all"),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// Same constants, same reasoning as /api/wines/search (SCAN-06): 0.5 is the
// measured floor that keeps "fredric" -> "Frédéric", and fuzzy rows only top
// up an exact pass that came back too thin.
const FUZZY_WORD_SIMILARITY_THRESHOLD = 0.5;
const FUZZY_FALLBACK_MIN_RESULTS = 5;
const PER_SOURCE_LIMIT = 20;

type Supabase = Extract<Awaited<ReturnType<typeof requireMembership>>, { supabase: unknown }>["supabase"];

function reportDegradation(phase: string, error: unknown, extra: Record<string, unknown>) {
  console.error(`unified search: ${phase} degraded:`, error);
  Sentry.captureException(error instanceof Error ? error : new Error(JSON.stringify(error)), {
    tags: { surface: "unified-search", phase },
    extra,
  });
}

// Verbatim from /api/wines/search — the proven quoting for a value embedded
// in a PostgREST `.or()` filter string: LIKE wildcards escaped, then the
// whole pattern double-quoted with inner quotes escaped.
function escapeLikePattern(value: string) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

function quotePostgrestPattern(value: string) {
  const escaped = escapeLikePattern(value).replaceAll('"', '\\"');
  return `"%${escaped}%"`;
}

async function fetchCellar(
  supabase: Supabase,
  restaurantId: string,
  q: string,
): Promise<CellarHit[]> {
  const columns =
    "id, name, producer, vintage, varietal, region, country, colour, hero_image_url, is_eightysixed, canonical_wine_id";
  const pattern = quotePostgrestPattern(q);
  // The D4 bug fix: free text spans region/varietal/country, not just
  // name+producer — "chablis" must find the tenant's Chablis by region.
  const orPattern = ["name", "producer", "region", "varietal", "country"]
    .map((column) => `${column}.ilike.${pattern}`)
    .join(",");

  const { data: exact, error } = await supabase
    .from("wines")
    .select(columns)
    .eq("restaurant_id", restaurantId)
    .or(orPattern)
    .order("producer")
    .limit(PER_SOURCE_LIMIT);
  if (error) throw error;

  type WineRow = {
    id: string;
    name: string;
    producer: string;
    vintage: number | null;
    varietal: string | null;
    region: string | null;
    country: string | null;
    colour: string | null;
    hero_image_url: string | null;
    is_eightysixed: boolean;
    canonical_wine_id: string | null;
  };
  const rows: Array<WineRow & { score: number }> = (exact ?? []).map((row: WineRow) => ({
    ...row,
    score: 1,
  }));

  if (rows.length < FUZZY_FALLBACK_MIN_RESULTS) {
    const { data: ranked, error: fuzzyError } = await supabase.rpc("search_wines_fuzzy", {
      p_restaurant_id: restaurantId,
      p_query: q,
      p_threshold: FUZZY_WORD_SIMILARITY_THRESHOLD,
      p_limit: PER_SOURCE_LIMIT,
    });
    if (fuzzyError) {
      // Same deploy-window rule as the old route: the exact pass already
      // answered; an unavailable enhancement must not break it.
      reportDegradation("cellar-fuzzy", fuzzyError, { restaurantId, q });
    } else {
      const shown = new Set(rows.map((row) => row.id));
      const missing = (ranked ?? []).filter((r) => !shown.has(r.wine_id));
      if (missing.length > 0) {
        const { data: fuzzyRows, error: fetchError } = await supabase
          .from("wines")
          .select(columns)
          .eq("restaurant_id", restaurantId)
          .in("id", missing.map((r) => r.wine_id));
        if (fetchError) {
          reportDegradation("cellar-fuzzy-fetch", fetchError, { restaurantId, q });
        } else {
          const scoreById = new Map(missing.map((r) => [r.wine_id, r.score]));
          for (const row of (fuzzyRows ?? []) as WineRow[]) {
            rows.push({ ...row, score: scoreById.get(row.id) ?? 0 });
          }
        }
      }
    }
  }

  // Canonical identity keys for the fold (D4 dedupe). Degrades to "no keys".
  const canonicalIds = [...new Set(rows.map((r) => r.canonical_wine_id).filter((v): v is string => v !== null))];
  const identityByCanonical = new Map<string, { lwin7: string | null; xwines_wine_id: number | null }>();
  if (canonicalIds.length > 0) {
    const { data: canonical, error: canonicalError } = await supabase
      .from("canonical_wines")
      .select("id, lwin7, xwines_wine_id")
      .in("id", canonicalIds);
    if (canonicalError) {
      reportDegradation("canonical-identity", canonicalError, { restaurantId, q });
    } else {
      for (const row of canonical ?? []) {
        identityByCanonical.set(row.id, { lwin7: row.lwin7, xwines_wine_id: row.xwines_wine_id });
      }
    }
  }

  return rows.map((row) => {
    const identity = row.canonical_wine_id !== null ? identityByCanonical.get(row.canonical_wine_id) : undefined;
    return {
      id: row.id,
      name: row.name,
      producer: row.producer,
      vintage: row.vintage,
      region: row.region,
      country: row.country,
      varietal: row.varietal,
      colour: row.colour,
      heroImageUrl: row.hero_image_url,
      isEightysixed: row.is_eightysixed,
      lwin7: identity?.lwin7 ?? null,
      xwinesWineId: identity?.xwines_wine_id ?? null,
      score: row.score,
    };
  });
}

async function fetchAcceptedLinks(
  supabase: Supabase,
  lwinIds: string[],
  xwinesIds: number[],
  extra: Record<string, unknown>,
): Promise<Map<string, number>> {
  const links = new Map<string, number>();
  const collect = (rows: Array<{ lwin_id: string; xwines_wine_id: number | null }> | null) => {
    for (const row of rows ?? []) {
      if (row.xwines_wine_id !== null) links.set(row.lwin_id, row.xwines_wine_id);
    }
  };
  if (lwinIds.length > 0) {
    const { data, error } = await supabase
      .from("lwin_xwines_links")
      .select("lwin_id, xwines_wine_id")
      .eq("status", "accepted")
      .in("lwin_id", lwinIds);
    if (error) {
      // 0145 not applied yet: no links means no dedupe CLAIMS — the honest
      // fallback the interim contract demands, not an error the reader sees.
      reportDegradation("links-by-lwin", error, extra);
      return links;
    }
    collect(data);
  }
  if (xwinesIds.length > 0) {
    const { data, error } = await supabase
      .from("lwin_xwines_links")
      .select("lwin_id, xwines_wine_id")
      .eq("status", "accepted")
      .in("xwines_wine_id", xwinesIds);
    if (error) {
      reportDegradation("links-by-xwines", error, extra);
      return links;
    }
    collect(data);
  }
  return links;
}

export async function GET(request: NextRequest) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  const parsed = await parseQuery(request.nextUrl.searchParams, QuerySchema);
  if (!parsed.ok) return parsed.response;
  const { q, scope, limit } = parsed.data;

  if (q.length < 2) return NextResponse.json({ results: [] });

  let cellar: CellarHit[];
  try {
    cellar = await fetchCellar(supabase, restaurantId, q);
  } catch (error) {
    console.error("unified search: cellar pass failed:", error);
    Sentry.captureException(error, {
      tags: { surface: "unified-search", phase: "cellar" },
      extra: { restaurantId, q },
    });
    return NextResponse.json({ error: "Search failed." }, { status: 500 });
  }

  let lwin: LwinHit[] = [];
  let xwines: XwinesHit[] = [];
  if (scope === "all") {
    const [lwinResult, xwinesResult] = await Promise.all([
      supabase.rpc("lwin_search", { p_query: q, p_limit: PER_SOURCE_LIMIT }),
      supabase.rpc("xwines_search", { p_query: q, p_limit: PER_SOURCE_LIMIT }),
    ]);
    if (lwinResult.error) {
      reportDegradation("lwin-search", lwinResult.error, { restaurantId, q });
    } else {
      lwin = (lwinResult.data ?? []).map((row) => ({
        lwinId: row.lwin_id,
        displayName: row.display_name,
        producer: row.producer,
        region: row.region,
        country: row.country,
        colour: row.colour,
        type: row.type,
        // lwin_search orders by similarity but does not return it; rank
        // position stands in until the RPC grows a score column.
        score: 0.75,
      }));
    }
    if (xwinesResult.error) {
      reportDegradation("xwines-search", xwinesResult.error, { restaurantId, q });
    } else {
      xwines = (xwinesResult.data ?? []).map((row) => ({
        wineId: row.wine_id,
        name: row.name,
        wineryName: row.winery_name,
        regionName: row.region_name,
        country: row.country,
        type: row.type,
        imageUrl: row.image_kind === "label" ? row.image_url : null,
        score: row.score,
      }));
    }
  }

  const acceptedLinks =
    lwin.length > 0 || xwines.length > 0
      ? await fetchAcceptedLinks(
          supabase,
          lwin.map((h) => h.lwinId),
          xwines.map((h) => h.wineId),
          { restaurantId, q },
        )
      : new Map<string, number>();

  const results = mergeUnifiedResults({ cellar, lwin, xwines, acceptedLinks, limit });
  return NextResponse.json({ results });
}
