import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireMembership } from "@/lib/api/auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase } = auth;

  const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) {
    return NextResponse.json([]);
  }

  const { data, error } = await supabase.rpc("lwin_search", {
    p_query: q,
    p_limit: 20,
  });

  if (error) {
    console.error("lwin_search failed:", error);
    Sentry.captureException(error, {
      tags: { surface: "wines-lwin-search", phase: "lwin_search-rpc" },
      extra: { q },
    });
    return NextResponse.json([], { status: 500 });
  }

  return NextResponse.json(data ?? []);
}
