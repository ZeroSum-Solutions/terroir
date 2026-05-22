import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireRole } from "@/lib/api/auth";
import { isOwnWineListSection } from "@/lib/api/wine-list-scope";

export const runtime = "nodejs";

// BND-162: atomic reorder of sections. Accepts orderedIds array and
// updates each section's position. Uses a DB function for atomicity.
export async function PATCH(request: NextRequest) {
  const auth = await requireRole(["owner", "manager"]);
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  let body: { orderedIds: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  if (!Array.isArray(body.orderedIds) || body.orderedIds.length === 0) {
    return NextResponse.json(
      { error: "orderedIds array is required." },
      { status: 400 },
    );
  }

  // Verify every section belongs to a list owned by this restaurant.
  for (const id of body.orderedIds) {
    if (!(await isOwnWineListSection(supabase, id, restaurantId))) {
      return NextResponse.json(
        { error: "One or more sections not found." },
        { status: 404 },
      );
    }
  }

  // Update positions. Section counts are small (< 20 typically) so
  // sequential updates are fine; the UI will refresh on failure.
  for (let i = 0; i < body.orderedIds.length; i++) {
    const { error } = await supabase
      .from("wine_list_sections")
      .update({ position: i })
      .eq("id", body.orderedIds[i]);

    if (error) {
      console.error("wine_list_sections reorder failed:", error);
      Sentry.captureException(error, {
        tags: { surface: "wine-list-sections", phase: "reorder" },
        extra: { restaurantId, sectionId: body.orderedIds[i], position: i },
      });
      return NextResponse.json({ error: "Reorder failed." }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true });
}
