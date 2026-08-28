import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireRole } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";

export const runtime = "nodejs";

type OwnedSection = {
  id: string;
  name: string;
  wine_list_id: string;
  wine_lists: { restaurant_id: string };
};

// BND-162: atomic reorder of sections. Accepts orderedIds array and
// updates each section's position.
//
// PERF: batched into two round trips (was 2N — one ownership check plus
// one position UPDATE per section id). The ownership fetch also returns
// name/wine_list_id so the follow-up upsert can satisfy the table's
// NOT NULL columns on the ON CONFLICT DO UPDATE insert branch.
export async function PATCH(request: NextRequest) {
  const auth = await requireRole(["owner", "manager"]);
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  let body: { orderedIds: string[] };
  try {
    body = await request.json();
  } catch {
    return Errors.badRequest("Invalid JSON.");
  }

  if (!Array.isArray(body.orderedIds) || body.orderedIds.length === 0) {
    return Errors.badRequest("orderedIds array is required.");
  }

  // Verify every section belongs to a list owned by this restaurant, and
  // fetch the fields the upsert below needs.
  const { data: sections, error: ownerError } = await supabase
    .from("wine_list_sections")
    .select("id, name, wine_list_id, wine_lists!inner(restaurant_id)")
    .in("id", body.orderedIds);

  if (ownerError) {
    console.error("wine_list_sections ownership check failed:", ownerError);
    Sentry.captureException(ownerError, {
      tags: { surface: "wine-list-sections", phase: "reorder-owner-check" },
      extra: { restaurantId, sectionCount: body.orderedIds.length },
    });
    return Errors.internal("Reorder failed.");
  }

  const rows = (sections ?? []) as unknown as OwnedSection[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const allOwned =
    rows.length === body.orderedIds.length &&
    rows.every((r) => r.wine_lists.restaurant_id === restaurantId);
  if (!allOwned) {
    return Errors.notFound("One or more sections");
  }

  // Single batched upsert — position is the array index.
  const { error } = await supabase.from("wine_list_sections").upsert(
    body.orderedIds.map((id, position) => {
      const section = byId.get(id)!;
      return {
        id,
        position,
        name: section.name,
        wine_list_id: section.wine_list_id,
      };
    }),
  );

  if (error) {
    console.error("wine_list_sections reorder failed:", error);
    Sentry.captureException(error, {
      tags: { surface: "wine-list-sections", phase: "reorder" },
      extra: { restaurantId, sectionCount: body.orderedIds.length },
    });
    return Errors.internal("Reorder failed.");
  }

  return NextResponse.json({ ok: true });
}
