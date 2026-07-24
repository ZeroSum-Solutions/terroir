import { NextResponse, type NextRequest } from "next/server";
import { requireMembership } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { parseQuery } from "@/lib/api/validation";
import { WineSearchQuerySchema } from "@/lib/api/wine-read-query-schemas";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  return withApiHandler(async () => {
    const auth = await requireMembership();
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsedQuery = await parseQuery(
      request.nextUrl.searchParams,
      WineSearchQuerySchema,
    );
    if (!parsedQuery.ok) return parsedQuery.response;
    const { q } = parsedQuery.data;

    let query = supabase
      .from("wines")
      .select("id, name, producer, vintage, varietal, region")
      .eq("restaurant_id", restaurantId)
      .order("producer")
      .limit(20);

    if (q) {
      // PostgREST's `.or()` accepts raw filter syntax. Quoting and escaping
      // keeps commas, parentheses, and quotes inside the ILIKE value.
      const pattern = quotePostgrestValue(`%${q}%`);
      query = query.or(
        `name.ilike.${pattern},producer.ilike.${pattern}`,
      );
    }

    const { data: wines, error } = await query;
    if (error) throw error;

    return NextResponse.json(wines ?? []);
  });
}

function quotePostgrestValue(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
