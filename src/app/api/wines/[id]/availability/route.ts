import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { requireRole } from "@/lib/api/auth";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

const BodySchema = z.object({
  direction: z.enum(["eightysixed", "restored"]),
  note: z.string().trim().max(500).optional(),
});

type RpcEvent = {
  id: string;
  wine_id: string;
  restaurant_id: string;
  direction: "eightysixed" | "restored";
  user_id: string | null;
  note: string | null;
  created_at: string;
};

/**
 * PATCH /api/wines/[id]/availability
 *
 * BND-037. Toggle a wine's 86'd state. Role-gated to owner + manager
 * via the new requireRole helper. Delegates to set_wine_availability
 * RPC (atomic: updates wines AND inserts an availability_events row
 * in one transaction; idempotent by state — returns an empty set if
 * already in target state, one row on change).
 *
 * On state change: revalidates every published wine list that
 * references this wine, so public /list/[slug] pages see fresh state
 * within seconds (BND-037 section: public-list refresh = A / instant).
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Params },
) {
  const { id } = await params;

  const auth = await requireRole(["owner", "manager"]);
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
  const { direction, note } = parsed.data;

  // Defense-in-depth: confirm the wine is in the caller's restaurant.
  // RLS already scopes, but an explicit SELECT + .eq() keeps the 404
  // path crisp (same pattern used by BND-008 / BND-025 / BND-029).
  const { data: scope, error: scopeError } = await supabase
    .from("wines")
    .select("id")
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .maybeSingle();

  if (scopeError) {
    console.error("wine scope check failed:", scopeError);
    Sentry.captureException(scopeError, {
      tags: { surface: "availability", phase: "scope-check" },
      extra: { wineId: id, restaurantId },
    });
    return NextResponse.json({ error: "Lookup failed." }, { status: 500 });
  }
  if (!scope) {
    return NextResponse.json({ error: "Wine not found." }, { status: 404 });
  }

  // The generated Database type doesn't yet include this RPC. Using
  // the same explicit-cast pattern as BND-026 / BND-031. Drop when
  // `supabase gen types` runs in CI (tracked carry-forward).
  const { data: events, error: rpcError } = await (supabase.rpc as unknown as (
    fn: string,
    args: { p_wine_id: string; p_direction: string; p_note: string | null },
  ) => Promise<{ data: RpcEvent[] | null; error: unknown }>)(
    "set_wine_availability",
    { p_wine_id: id, p_direction: direction, p_note: note ?? null },
  );

  if (rpcError) {
    console.error("set_wine_availability failed:", rpcError);
    Sentry.captureException(rpcError, {
      tags: { surface: "availability", phase: "set_wine_availability-rpc" },
      extra: { wineId: id, restaurantId, direction },
    });
    return NextResponse.json({ error: "Update failed." }, { status: 500 });
  }

  // SETOF → empty array when the wine was already in target state
  // (idempotent no-op). One-element array when a state change happened.
  if (!events || events.length === 0) {
    return NextResponse.json({ changed: false });
  }

  const event = events[0];

  // Revalidate every published wine list that references this wine so
  // the public /list/[slug] page reflects the new 86'd state ~instantly.
  // Nested !inner filter keeps lists-with-no-matching-items out of the
  // result set.
  const { data: affected } = await supabase
    .from("wine_lists")
    .select(
      "slug, wine_list_sections!inner(wine_list_items!inner(wine_id))",
    )
    .eq("is_published", true)
    .eq("restaurant_id", restaurantId)
    .eq("wine_list_sections.wine_list_items.wine_id", id);

  for (const list of (affected ?? []) as Array<{ slug: string | null }>) {
    if (list.slug) revalidatePath(`/list/${list.slug}`);
  }

  return NextResponse.json({ changed: true, event });
}
