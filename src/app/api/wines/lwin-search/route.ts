import { NextResponse, type NextRequest } from "next/server";
import { requireMembership } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { parseQuery } from "@/lib/api/validation";
import { LwinSearchQuerySchema } from "@/lib/api/wine-read-query-schemas";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  return withApiHandler(async () => {
    const auth = await requireMembership();
    if (auth instanceof NextResponse) return auth;
    const { supabase } = auth;

    const parsedQuery = await parseQuery(
      request.nextUrl.searchParams,
      LwinSearchQuerySchema,
    );
    if (!parsedQuery.ok) return parsedQuery.response;
    const { q } = parsedQuery.data;
    if (q.length < 2) {
      return NextResponse.json([]);
    }

    const { data, error } = await supabase.rpc("lwin_search", {
      p_query: q,
      p_limit: 20,
    });
    if (error) throw error;

    return NextResponse.json(data ?? []);
  });
}
