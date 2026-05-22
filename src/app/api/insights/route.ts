import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireMembership } from "@/lib/api/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/insights — aggregate metrics for the authenticated restaurant. */
export async function GET() {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  try {
    // Fetch scans and inventory in parallel
    const [{ data: scans }, { data: inventoryItems }] = await Promise.all([
      supabase
        .from("invoice_scans")
        .select("id, distributor_name, item_count, accuracy_score, created_at")
        .eq("restaurant_id", restaurantId)
        .order("created_at", { ascending: false }),
      supabase
        .from("inventory_items")
        .select("quantity, unit_cost, wine_id, wines(varietal)")
        .eq("restaurant_id", restaurantId),
    ]);

    const allScans = scans ?? [];
    const items = inventoryItems ?? [];

    // This-month filter
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const monthScans = allScans.filter(
      (s) => new Date(s.created_at) >= startOfMonth,
    );

    // Core metrics
    const inventoryValue = items.reduce(
      (s, i) => s + i.quantity * i.unit_cost,
      0,
    );
    const totalBottles = items.reduce((s, i) => s + i.quantity, 0);
    const scanCount = monthScans.length;

    // Accuracy
    const avgAccuracy =
      allScans.length > 0
        ? allScans.reduce((s, sc) => s + (sc.accuracy_score ?? 0), 0) /
          allScans.length
        : null;

    // Varietal breakdown
    const varietalMap = new Map<string, number>();
    for (const item of items) {
      const varietal =
        (item.wines as { varietal: string | null } | null)?.varietal ??
        "Other";
      varietalMap.set(
        varietal,
        (varietalMap.get(varietal) ?? 0) + item.quantity * item.unit_cost,
      );
    }
    const varietalBreakdown = [...varietalMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, value]) => ({ name, value }));

    // Recent scans
    const recentScans = allScans.slice(0, 5).map((s) => ({
      id: s.id,
      distributor_name: s.distributor_name,
      item_count: s.item_count,
      accuracy_score: s.accuracy_score,
      created_at: s.created_at,
    }));

    return NextResponse.json({
      inventoryValue,
      totalBottles,
      scanCount,
      totalScans: allScans.length,
      avgAccuracy,
      varietalBreakdown,
      recentScans,
    });
  } catch (err) {
    Sentry.captureException(err, {
      tags: { surface: "insights", phase: "fetch" },
      extra: { restaurantId },
    });
    return NextResponse.json(
      { error: "Failed to load insights data." },
      { status: 500 },
    );
  }
}