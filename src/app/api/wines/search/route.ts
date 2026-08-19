import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { requireMembership } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { parseQuery } from "@/lib/api/validation";

export const runtime = "nodejs";

const QuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  producer: z.string().trim().min(1).max(200).optional(),
  region: z.string().trim().min(1).max(200).optional(),
  country: z.string().trim().min(1).max(200).optional(),
  varietal: z.string().trim().min(1).max(200).optional(),
  vintage_min: z.coerce.number().int().min(1000).max(3000).optional(),
  vintage_max: z.coerce.number().int().min(1000).max(3000).optional(),
  format: z.coerce.number().int().positive().optional(),
});

export async function GET(request: NextRequest) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  const parsed = await parseQuery(request.nextUrl.searchParams, QuerySchema);
  if (!parsed.ok) return parsed.response;
  const {
    q = "",
    producer,
    region,
    country,
    varietal,
    vintage_min: vintageMin,
    vintage_max: vintageMax,
    format,
  } = parsed.data;

  let query = supabase
    .from("wines")
    .select("id, name, producer, vintage, varietal, region")
    .eq("restaurant_id", restaurantId)
    .order("producer")
    .limit(20);

  if (q) {
    // Search by producer or name (case-insensitive)
    const pattern = quotePostgrestPattern(q);
    query = query.or(`name.ilike.${pattern},producer.ilike.${pattern}`);
  }
  if (producer) query = query.ilike("producer", escapeLikePattern(producer));
  if (region) query = query.ilike("region", escapeLikePattern(region));
  if (country) query = query.ilike("country", escapeLikePattern(country));
  if (varietal) query = query.ilike("varietal", escapeLikePattern(varietal));
  if (vintageMin != null) query = query.gte("vintage", vintageMin);
  if (vintageMax != null) query = query.lte("vintage", vintageMax);
  if (format != null) query = query.eq("size_ml", format);

  const { data: wines, error } = await query;

  if (error) {
    console.error("wines search failed:", error);
    Sentry.captureException(error, {
      tags: { surface: "wines-search", phase: "query" },
      extra: { restaurantId, q },
    });
    return Errors.internal("Search failed.");
  }

  return NextResponse.json(wines ?? []);
}

function quotePostgrestPattern(value: string) {
  const escaped = escapeLikePattern(value).replaceAll('"', '\\"');
  return `"%${escaped}%"`;
}

function escapeLikePattern(value: string) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}
