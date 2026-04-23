import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireAuth, requireOwner } from "@/lib/api/auth";
import { setActiveRestaurant } from "@/lib/api/active-restaurant";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

/**
 * PUT /api/restaurant/[id] — switch the caller's active restaurant to :id.
 * The membership check happens inside setActiveRestaurant; users who aren't
 * members of :id get a 403 and no cookie change.
 */
export async function PUT(
  _request: NextRequest,
  { params }: { params: Params },
) {
  const { id } = await params;
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { supabase, user } = auth;

  const result = await setActiveRestaurant(supabase, user.id, id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 403 });
  }
  return NextResponse.json({ ok: true, restaurantId: id });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Params },
) {
  const { id } = await params;
  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  if (id !== restaurantId) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  let body: { name?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  if (!body.name?.trim()) {
    return NextResponse.json({ error: "Name is required." }, { status: 400 });
  }

  const { error } = await supabase
    .from("restaurants")
    .update({ name: body.name.trim() })
    .eq("id", id);

  if (error) {
    console.error("restaurant update failed:", error);
    Sentry.captureException(error, {
      tags: { surface: "restaurant", phase: "update" },
      extra: { restaurantId, id },
    });
    return NextResponse.json({ error: "Update failed." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
