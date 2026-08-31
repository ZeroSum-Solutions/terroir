// GET /api/assistant?q=... — the grounded wine assistant.
//
// Answers a typed question from the tenant's own cellar, falling back to the
// reference corpus only when the cellar holds nothing that fits. There is no
// model call anywhere in this path: parseAssistantQuery turns the question
// into a whitelisted struct (see that module's header for the D-006b decision
// this implements), selectCellarMatches applies it, and every field returned
// is a column read from a row.
//
// The vocabulary handed to the parser is the TENANT'S OWN distinct country /
// region / varietal values. That is what makes "a red from Narnia" return
// nothing instead of an empty-but-confident filter: Narnia is not in the
// vocabulary, so it never becomes a constraint, and the response says so.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireMembership } from "@/lib/api/auth";
import { parseQuery } from "@/lib/api/validation";
import { parseAssistantQuery, type AssistantVocabulary } from "@/lib/wine-intelligence/assistant-query";
import { selectCellarMatches, type AssistantCellarWine } from "@/lib/wine-intelligence/assistant-match";
import type { AssistantCorpusWine, AssistantResponse } from "@/lib/wine-intelligence/assistant-types";

export const runtime = "nodejs";

const MAX_RESULTS = 8;
const MAX_CORPUS_RESULTS = 5;

const QuerySchema = z.object({ q: z.string().trim().max(300).optional() });

type WineRow = {
  id: string;
  name: string | null;
  producer: string | null;
  vintage: number | null;
  colour: string | null;
  country: string | null;
  region: string | null;
  varietal: string | null;
  retail_median: number | string | null;
  hero_image_url: string | null;
  canonical_wines: { xwines_wine_id: number | null } | { xwines_wine_id: number | null }[] | null;
};

type CatalogRow = {
  wine_id: number;
  name: string | null;
  type: string | null;
  body: string | null;
  elaborate: string | null;
  grapes: string[] | null;
  harmonize: string[] | null;
  rating_avg: number | string | null;
  rating_count: number | null;
  image_url: string | null;
  image_kind: string | null;
  winery_name: string | null;
  region_name: string | null;
  country: string | null;
};

const num = (v: number | string | null | undefined): number | null => {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** PostgREST returns an embedded to-one as an object or a single-element
 * array depending on how it infers the relationship; both are one row. */
const firstEmbedded = <T,>(v: T | T[] | null): T | null =>
  Array.isArray(v) ? (v[0] ?? null) : v;

const distinct = (values: (string | null)[]): string[] =>
  [...new Set(values.filter((v): v is string => typeof v === "string" && v.trim() !== ""))];

export async function GET(request: NextRequest) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  const parsed = await parseQuery(request.nextUrl.searchParams, QuerySchema);
  if (!parsed.ok) return parsed.response;
  const question = parsed.data.q ?? "";

  const { data: wineRows, error: wineError } = await supabase
    .from("wines")
    .select(
      "id, name, producer, vintage, colour, country, region, varietal, retail_median, hero_image_url, canonical_wines(xwines_wine_id)",
    )
    .eq("restaurant_id", restaurantId);
  if (wineError) {
    return NextResponse.json({ error: wineError.message }, { status: 500 });
  }
  const wines = (wineRows ?? []) as unknown as WineRow[];

  // Corpus attributes for the wines that carry a trusted link. Fetched in one
  // round trip and joined in memory; the cellar is a few hundred rows.
  const catalogIds = distinct(
    wines.map((w) => {
      const link = firstEmbedded(w.canonical_wines);
      return link?.xwines_wine_id != null ? String(link.xwines_wine_id) : null;
    }),
  ).map(Number);

  const catalogById = new Map<number, CatalogRow>();
  if (catalogIds.length > 0) {
    const { data: catalogRows } = await supabase
      .from("xwines_catalog")
      .select(
        "wine_id, name, type, body, elaborate, grapes, harmonize, rating_avg, rating_count, image_url, image_kind, winery_name, region_name, country",
      )
      .in("wine_id", catalogIds);
    for (const row of (catalogRows ?? []) as unknown as CatalogRow[]) {
      catalogById.set(row.wine_id, row);
    }
  }

  // On-hand counts. A wine with no inventory row is genuinely zero on hand,
  // not missing, so it stays in the list with onHand 0 and sorts last.
  const { data: inventoryRows } = await supabase
    .from("inventory_items")
    .select("wine_id, quantity")
    .eq("restaurant_id", restaurantId);
  const onHandByWine = new Map<string, number>();
  for (const row of (inventoryRows ?? []) as { wine_id: string; quantity: number | null }[]) {
    onHandByWine.set(row.wine_id, (onHandByWine.get(row.wine_id) ?? 0) + (row.quantity ?? 0));
  }

  const cellar: AssistantCellarWine[] = wines.map((w) => {
    const link = firstEmbedded(w.canonical_wines);
    const cat = link?.xwines_wine_id != null ? catalogById.get(link.xwines_wine_id) : undefined;
    return {
      wineId: w.id,
      name: w.name ?? "",
      producer: w.producer,
      vintage: w.vintage,
      colour: w.colour,
      country: w.country,
      region: w.region,
      varietal: w.varietal,
      price: num(w.retail_median),
      onHand: onHandByWine.get(w.id) ?? 0,
      type: cat?.type ?? null,
      body: cat?.body ?? null,
      grapes: cat?.grapes ?? [],
      pairings: cat?.harmonize ?? [],
      ratingAvg: num(cat?.rating_avg ?? null),
      ratingCount: cat?.rating_count ?? null,
      imageUrl: w.hero_image_url ?? cat?.image_url ?? null,
      elaborate: cat?.elaborate ?? null,
    };
  });

  const vocabulary: AssistantVocabulary = {
    country: distinct(cellar.map((w) => w.country)),
    region: distinct(cellar.map((w) => w.region)),
    grape: distinct([
      ...cellar.map((w) => w.varietal),
      ...cellar.flatMap((w) => w.grapes),
    ]),
  };

  const query = parseAssistantQuery(question, vocabulary);
  const matches = selectCellarMatches(cellar, query);

  // The corpus lane runs only when the question WAS understood and the cellar
  // still had nothing — otherwise an unparsed question would answer with a
  // corpus list, which reads as an answer to a question nobody asked.
  let corpus: AssistantCorpusWine[] = [];
  if (query.understood.length > 0 && matches.length === 0) {
    let q = supabase
      .from("xwines_catalog")
      .select(
        "wine_id, name, type, body, elaborate, grapes, harmonize, rating_avg, rating_count, image_url, image_kind, winery_name, region_name, country",
      )
      .not("rating_count", "is", null);
    if (query.type) q = q.eq("type", query.type);
    if (query.body) q = q.eq("body", query.body);
    if (query.country) q = q.eq("country", query.country);
    if (query.region) q = q.eq("region_name", query.region);
    if (query.grape) q = q.contains("grapes", [query.grape]);
    if (query.blend === true) q = q.like("elaborate", "Assemblage%");
    if (query.blend === false) q = q.eq("elaborate", "Varietal/100%");
    if (query.pairing && query.pairing.length > 0) q = q.overlaps("harmonize", query.pairing);

    const { data: corpusRows } = await q
      .order("rating_count", { ascending: false })
      .limit(MAX_CORPUS_RESULTS);

    corpus = ((corpusRows ?? []) as unknown as CatalogRow[]).map((row) => ({
      wineId: row.wine_id,
      name: row.name ?? "",
      winery: row.winery_name,
      country: row.country,
      region: row.region_name,
      type: row.type,
      body: row.body,
      grapes: row.grapes ?? [],
      pairings: row.harmonize ?? [],
      ratingAvg: num(row.rating_avg),
      ratingCount: row.rating_count,
      imageUrl: row.image_url,
      imageKind: row.image_kind,
    }));
  }

  const body: AssistantResponse = {
    query,
    cellar: matches.slice(0, MAX_RESULTS),
    cellarTotal: matches.length,
    corpus,
  };
  return NextResponse.json(body);
}
