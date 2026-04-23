import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { requireMembership } from "@/lib/api/auth";

export const runtime = "nodejs";

/**
 * BND-025 / DEBT-005 — wire 'Add section' button in the wine-list editor.
 *
 * POST /api/wine-list-sections creates a new section at the end of the
 * given list. Defense-in-depth: we verify the wine_list_id belongs to a
 * list owned by the caller's restaurant before inserting, so a leaked id
 * from another tenant 404s instead of silently inserting.
 */

const BodySchema = z.object({
  wine_list_id: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
});

export async function POST(request: NextRequest) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body.", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { wine_list_id, name } = parsed.data;

  // Defense-in-depth: confirm the list belongs to this restaurant before
  // inserting. RLS on wine_list_sections also enforces this via the
  // wine_lists join, but an explicit pre-check returns a clean 404
  // instead of a 403/RLS error downstream.
  const { data: ownerCheck, error: ownerError } = await supabase
    .from("wine_lists")
    .select("id")
    .eq("id", wine_list_id)
    .eq("restaurant_id", restaurantId)
    .maybeSingle();

  if (ownerError) {
    console.error("wine_lists owner check failed:", ownerError);
    Sentry.captureException(ownerError, {
      tags: { surface: "wine-list-sections", phase: "owner-check" },
      extra: { restaurantId, wine_list_id },
    });
    return NextResponse.json({ error: "Lookup failed." }, { status: 500 });
  }
  if (!ownerCheck) {
    return NextResponse.json({ error: "Wine list not found." }, { status: 404 });
  }

  // Assign position = current count (0-indexed). Race-unsafe under
  // concurrent adds, but acceptable for a single-user editor surface —
  // collisions surface as a 500 from the unique constraint and the user
  // retries. Wrap in an RPC if this becomes real (see BND-026 pattern).
  const { count, error: countError } = await supabase
    .from("wine_list_sections")
    .select("id", { count: "exact", head: true })
    .eq("wine_list_id", wine_list_id);

  if (countError) {
    console.error("wine_list_sections count failed:", countError);
    Sentry.captureException(countError, {
      tags: { surface: "wine-list-sections", phase: "count" },
      extra: { restaurantId, wine_list_id },
    });
    return NextResponse.json({ error: "Count failed." }, { status: 500 });
  }

  const position = count ?? 0;

  const { data: inserted, error: insertError } = await supabase
    .from("wine_list_sections")
    .insert({ wine_list_id, name, position })
    .select("id, wine_list_id, name, position, created_at")
    .single();

  if (insertError) {
    console.error("wine_list_sections insert failed:", insertError);
    Sentry.captureException(insertError, {
      tags: { surface: "wine-list-sections", phase: "insert" },
      extra: { restaurantId, wine_list_id, position },
    });
    return NextResponse.json({ error: "Insert failed." }, { status: 500 });
  }

  return NextResponse.json(inserted, { status: 201 });
}
