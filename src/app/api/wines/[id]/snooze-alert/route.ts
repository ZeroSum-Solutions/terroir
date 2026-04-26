import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireMembership } from "@/lib/api/auth";

export const runtime = "nodejs";

/**
 * BND-039 — POST /api/wines/[id]/snooze-alert
 *
 * Snooze the drink-window briefing alert for a wine. Default 30 days,
 * configurable via JSON body `{ days: number }`.
 *
 * Auth: owner+manager only (architect-review finding 1 — this is a
 * deliberate API-layer gate, not a SECURITY DEFINER trigger pattern,
 * because snooze is UX state not security-critical: worst case is
 * staff hides their own alert dashboard, not a data-leak path).
 *
 * Calls `snooze_drink_window_alert` RPC (added in migration 0025) which
 * returns the timestamp the snooze runs until.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId, role } = auth;

  if (role !== "owner" && role !== "manager") {
    return NextResponse.json(
      { error: "Snoozing alerts requires owner or manager role." },
      { status: 403 },
    );
  }

  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: "wine id required" }, { status: 400 });
  }

  // Optional body: { days: number }. Defaults to 30 (RPC default).
  // Cap at 365 to avoid "snooze forever" bugs.
  let days = 30;
  try {
    const body = await req.json().catch(() => ({}));
    if (typeof body?.days === "number" && Number.isFinite(body.days)) {
      days = Math.max(1, Math.min(365, Math.round(body.days)));
    }
  } catch {
    // No body / non-JSON → use default. Not an error.
  }

  // Tenant-scope check before invoking the RPC. The RPC itself doesn't
  // filter by restaurant_id (matches Supabase RLS pattern), so we
  // verify ownership here.
  const { data: wine, error: fetchErr } = await supabase
    .from("wines")
    .select("id")
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .maybeSingle();

  if (fetchErr) {
    Sentry.captureException(fetchErr, {
      tags: { surface: "wines-snooze", phase: "wine-fetch" },
      extra: { wineId: id, restaurantId },
    });
    return NextResponse.json({ error: "Lookup failed." }, { status: 500 });
  }
  if (!wine) {
    return NextResponse.json({ error: "Wine not found." }, { status: 404 });
  }

  const { data: until, error: rpcError } = await supabase.rpc(
    "snooze_drink_window_alert",
    { p_wine_id: id, p_days: days },
  );

  if (rpcError) {
    Sentry.captureException(rpcError, {
      tags: { surface: "wines-snooze", phase: "rpc" },
      extra: { wineId: id, restaurantId, days },
    });
    return NextResponse.json(
      { error: "Failed to snooze alert." },
      { status: 500 },
    );
  }

  return NextResponse.json({
    wineId: id,
    snoozedUntil: until,
    days,
  });
}
