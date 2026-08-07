import { NextResponse, type NextRequest } from "next/server";
import { requireCapability } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { parseQuery } from "@/lib/api/validation";
import { WineCollectionQuerySchema } from "@/lib/api/compatibility-collection-schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Returns a paginated, tenant-scoped wine collection with optional filters. */
export async function GET(request: NextRequest) {
  return withApiHandler(async () => {
    const auth = await requireCapability("wine:view");
    if (auth instanceof NextResponse) return auth;

    const parsed = await parseQuery(
      request.nextUrl.searchParams,
      WineCollectionQuerySchema,
    );
    if (!parsed.ok) return parsed.response;
    const { limit, offset, q, varietal, region, is_eightysixed } = parsed.data;

    let query = auth.supabase
      .from("wines")
      .select("*", { count: "exact" })
      .eq("restaurant_id", auth.restaurantId)
      .order("producer", { ascending: true })
      .order("name", { ascending: true })
      .order("id", { ascending: true });

    if (q) {
      const filter = quotePostgrestValue(`%${q}%`);
      query = query.or(`name.ilike.${filter},producer.ilike.${filter}`);
    }
    if (varietal) query = query.ilike("varietal", `%${varietal}%`);
    if (region) query = query.ilike("region", `%${region}%`);
    if (is_eightysixed) query = query.eq("is_eightysixed", is_eightysixed === "true");

    const { data, error, count } = await query.range(offset, offset + limit - 1);
    if (error) throw error;

    return NextResponse.json({
      wines: data ?? [],
      total: count ?? data?.length ?? 0,
      limit,
      offset,
    });
  });
}

function quotePostgrestValue(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
