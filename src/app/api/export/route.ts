import { NextResponse } from "next/server";
import { requireCapability } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { streamToastCsv } from "./toast-csv/route";

export const runtime = "nodejs";

/** Streams the default CSV export for the active restaurant. */
export async function GET() {
  return withApiHandler(async () => {
    const auth = await requireCapability("export:read");
    if (auth instanceof NextResponse) return auth;
    return streamToastCsv(auth.supabase, auth.restaurantId);
  });
}
