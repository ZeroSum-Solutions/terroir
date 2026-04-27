import { NextResponse } from "next/server";
import { requireMembership } from "@/lib/api/auth";
import { enrichRestaurantBatch } from "@/lib/wine-intelligence/batch";

export const runtime = "nodejs";

export async function POST() {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId, role } = auth;

  // BND-039 — owner+manager only. requireMembership alone passes staff
  // through; without this gate, staff role can trigger Anthropic
  // billable Claude calls. Mirrors the snooze-alert role check.
  if (role !== "owner" && role !== "manager") {
    return NextResponse.json(
      { error: "Enriching wines requires owner or manager role." },
      { status: 403 },
    );
  }

  const result = await enrichRestaurantBatch({ supabase, restaurantId });

  if (result.error) {
    return NextResponse.json(
      { error: result.error },
      { status: result.status },
    );
  }

  return NextResponse.json(result);
}
