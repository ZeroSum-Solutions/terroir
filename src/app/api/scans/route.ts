import { NextResponse, type NextRequest } from "next/server";
import { requireCapability } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { parseQuery } from "@/lib/api/validation";
import { ScanCollectionQuerySchema } from "@/lib/api/compatibility-collection-schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Lists invoice scans for the active restaurant. */
export async function GET(request: NextRequest) {
  return withApiHandler(async () => {
    const auth = await requireCapability("scan:create", {
      rateLimit: "standard",
    });
    if (auth instanceof NextResponse) return auth;

    const parsed = await parseQuery(
      request.nextUrl.searchParams,
      ScanCollectionQuerySchema,
    );
    if (!parsed.ok) return parsed.response;
    const { limit, offset, status } = parsed.data;

    let query = auth.supabase
      .from("invoice_scans")
      .select(
        "id, distributor_name, invoice_number, invoice_date, status, item_count, accuracy_score, created_at",
        { count: "exact" },
      )
      .eq("restaurant_id", auth.restaurantId)
      .order("created_at", { ascending: false });
    if (status) query = query.eq("status", status);

    const { data, error, count } = await query.range(offset, offset + limit - 1);
    if (error) throw error;

    return NextResponse.json({
      scans: data ?? [],
      total: count ?? data?.length ?? 0,
      limit,
      offset,
    });
  });
}
