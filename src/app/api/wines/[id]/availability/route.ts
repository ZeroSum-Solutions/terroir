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

  // The generator emits `p_note: string` (not `string | null`) because it
  // doesn't translate SQL DEFAULT NULL into nullability. Runtime Postgres
  // accepts NULL here, so cast through `as unknown as string`.
  const { data: events, error: rpcError } = await supabase.rpc(
    "set_wine_availability",
    {
      p_wine_id: id,
      p_direction: direction,
      p_note: (note ?? null) as unknown as string,
    },
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

  // ARCH-018: do NOT surface the full availability_events row on the
  // HTTP response. It carries user_id + restaurant_id which have no
  // client consumer and expand the attack surface of this endpoint.
  // Narrow to the two fields the UI uses (direction + occurred_at).
  // If a future UI needs the audit detail it should go through a
  // scoped events endpoint that enforces its own RLS / restaurant
  // filter.
  const event = events[0];
  const narrowed = {
    direction: event.direction,
    occurred_at: event.created_at,
  };

  // ARCH-019: revalidation target list comes from a stable SQL RPC
  // (wine_published_list_slugs, migration 0019), not a PostgREST
  // nested !inner filter. The embed-filter syntax is PostgREST-
  // version-fragile and silently degrades if the operator semantics
  // change; SQL is explicit and survives upgrades.
  const { data: affected } = await supabase.rpc(
    "wine_published_list_slugs",
    { p_wine_id: id, p_restaurant_id: restaurantId },
  );

  for (const row of (affected ?? []) as Array<{ slug: string }>) {
    revalidatePath(`/list/${row.slug}`);
  }

  return NextResponse.json({ changed: true, event: narrowed });
}
