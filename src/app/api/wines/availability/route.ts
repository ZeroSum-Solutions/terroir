import { NextResponse, type NextRequest } from "next/server";
import { requireMembership } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { parseQuery } from "@/lib/api/validation";
import { WineAvailabilityQuerySchema } from "@/lib/api/wine-read-query-schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/wines/availability
 *
 * BND-037. Returns every wine in the caller's restaurant with its
 * current 86'd state. Consumed by the /availability page (browse +
 * toggle) and available as a public API for future clients.
 *
 * Pagination: offset-based. Invalid or out-of-range values return 400.
 * RFC 5988 `Link` headers (next/prev/first/last) are emitted so
 * clients can discover paging without inspecting the body. A typical
 * restaurant has <1000 wines, so the default page returns everything;
 * the Link header is future-proofing for large cellars.
 *
 * Query params:
 *   - `limit`  (1..1000, default 1000)
 *   - `offset` (>= 0, default 0)
 *
 * Auth: requireMembership (all three roles). The PATCH sibling is
 * role-gated via requireRole(['owner','manager']); this endpoint is
 * intentionally readable by staff.
 *
 * Note: the `eightysixed_by` column holds a `uuid` referencing
 * `auth.users(id)`. We intentionally do NOT embed the user's email
 * here — PostgREST can't resolve embeds across schema boundaries
 * (auth vs public) and exposing `auth` in the PostgREST schema
 * config would be a security regression. If attributing 86's to
 * named people matters later, add a public-schema view that
 * joins memberships -> auth.users and scopes to the caller's
 * restaurant via RLS, then embed through that.
 */
export async function GET(request: NextRequest) {
  return withApiHandler(async () => {
    const auth = await requireMembership();
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsedQuery = await parseQuery(
      request.nextUrl.searchParams,
      WineAvailabilityQuerySchema,
    );
    if (!parsedQuery.ok) return parsedQuery.response;
    const { limit, offset } = parsedQuery.data;

    const { data, error, count } = await supabase
      .from("wines")
      .select(
        "id, name, producer, vintage, varietal, region, is_eightysixed, eightysixed_at, eightysixed_by",
        { count: "exact" },
      )
      .eq("restaurant_id", restaurantId)
      .order("name", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + limit - 1);
    if (error) throw error;

    const total = count ?? (data?.length ?? 0);
    const headers = new Headers();
    headers.set("X-Total-Count", String(total));
    const linkHeader = buildLinkHeader(request.nextUrl, limit, offset, total);
    if (linkHeader) headers.set("Link", linkHeader);

    return NextResponse.json(
      { wines: data ?? [], total, limit, offset },
      { headers },
    );
  });
}

/**
 * Build an RFC 5988 Link header with rel="next"|"prev"|"first"|"last".
 * Only emits rels that make sense for the current page — e.g. no
 * "prev" on offset=0, no "next" when we've returned the last page.
 */
function buildLinkHeader(
  baseUrl: URL,
  limit: number,
  offset: number,
  total: number,
): string | null {
  if (total <= limit && offset === 0) return null;

  const mk = (off: number): string => {
    const u = new URL(baseUrl);
    u.searchParams.set("limit", String(limit));
    u.searchParams.set("offset", String(off));
    return u.pathname + u.search;
  };

  const parts: string[] = [];

  parts.push(`<${mk(0)}>; rel="first"`);

  const lastOffset = Math.max(
    0,
    Math.floor((total - 1) / limit) * limit,
  );
  parts.push(`<${mk(lastOffset)}>; rel="last"`);

  if (offset > 0) {
    parts.push(`<${mk(Math.max(0, offset - limit))}>; rel="prev"`);
  }
  if (offset + limit < total) {
    parts.push(`<${mk(offset + limit)}>; rel="next"`);
  }

  return parts.join(", ");
}
