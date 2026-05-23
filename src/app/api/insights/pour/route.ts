import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireMembership } from "@/lib/api/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_RANGES = new Set(["7d", "30d", "90d", "all", "custom"]);

/**
 * GET /api/insights/pour?range=30d&topN=10
 * Also supports range=custom&from=YYYY-MM-DD&to=YYYY-MM-DD
 */
export async function GET(request: NextRequest) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  const url = new URL(request.url);
  const range = VALID_RANGES.has(url.searchParams.get("range") ?? "")
    ? url.searchParams.get("range")!
    : "30d";
  const topN = Math.min(
    Math.max(parseInt(url.searchParams.get("topN") ?? "10", 10) || 10, 1),
    50,
  );

  try {
    let since: Date | null = null;
    let until: Date | null = null;

    if (range === "custom") {
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      if (from) {
        since = new Date(from + "T00:00:00");
        if (Number.isNaN(since.getTime())) since = null;
      }
      if (to) {
        until = new Date(to + "T23:59:59.999");
        if (Number.isNaN(until.getTime())) until = null;
      }
    } else if (range !== "all") {
      const days = parseInt(range.replace("d", ""), 10);
      since = new Date();
      since.setDate(since.getDate() - days);
      since.setHours(0, 0, 0, 0);
    }

    const pourQuery = supabase
      .from("pour_events")
      .select(
        "wine_id, ml_delta, kind, occurred_at, wines!inner(id, name, producer, vintage)",
      )
      .eq("restaurant_id", restaurantId)
      .order("occurred_at", { ascending: false });

    if (since) pourQuery.gte("occurred_at", since.toISOString());
    if (until) pourQuery.lte("occurred_at", until.toISOString());

    const [
      { data: pourEventsRaw },
      { data: inventoryItems },
      { data: listItems },
    ] = await Promise.all([
      pourQuery,
      supabase
        .from("inventory_items")
        .select("wine_id, section")
        .eq("restaurant_id", restaurantId),
      supabase
        .from("wine_list_items")
        .select(
          "wine_id, glass_price, glass_pour_ml, updated_at, " +
            "wine_list_sections!inner(wine_lists!inner(id, restaurant_id))",
        )
        .eq("wine_list_sections.wine_lists.restaurant_id", restaurantId)
        .order("updated_at", { ascending: false }),
    ]);

    const pourEvents = pourEventsRaw ?? [];

    // --- Pour volume by section ---
    const wineSection = new Map<string, string>();
    for (const item of inventoryItems ?? []) {
      if (item.section && !wineSection.has(item.wine_id)) {
        wineSection.set(item.wine_id, item.section);
      }
    }

    const sectionMl = new Map<string, number>();
    for (const event of pourEvents) {
      if (event.kind !== "pour" || event.ml_delta <= 0) continue;
      const section = wineSection.get(event.wine_id) ?? "Unsectioned";
      sectionMl.set(section, (sectionMl.get(section) ?? 0) + event.ml_delta);
    }

    const pourVolumeBySection = Array.from(sectionMl.entries())
      .map(function (_a) {
        var section = _a[0];
        var ml = _a[1];
        return {
          section: section,
          oz: Math.round(ml * 0.033814 * 10) / 10,
        };
      })
      .sort(function (a, b) { return b.oz - a.oz; });

    // --- Top wines by pour count ---
    const pourCountByWine = new Map<string, number>();
    for (const event of pourEvents) {
      if (event.kind !== "pour") continue;
      pourCountByWine.set(
        event.wine_id,
        (pourCountByWine.get(event.wine_id) ?? 0) + 1,
      );
    }

    const topWinesByPours = Array.from(pourCountByWine.entries())
      .sort(function (a, b) { return b[1] - a[1]; })
      .slice(0, topN)
      .map(function (_a) {
        var wineId = _a[0];
        var count = _a[1];
        const wine = pourEvents.find(function (e) { return e.wine_id === wineId; });
        const w = wine?.wines as
          | { name: string; producer: string; vintage: number | null }
          | undefined;
        return {
          wine_id: wineId,
          name: w?.name ?? "Unknown",
          producer: w?.producer ?? "Unknown",
          vintage: w?.vintage ?? null,
          pour_count: count,
        };
      });

    // --- Top wines by revenue ---
    const winePrice = new Map<string, { glassPrice: number; pourMl: number }>();
    for (const item of (listItems ?? []) as unknown as Array<{
      wine_id: string;
      glass_price: number | null;
      glass_pour_ml: number | null;
      wine_list_sections:
        | {
            wine_lists:
              | { id: string; restaurant_id: string }
              | { id: string; restaurant_id: string }[];
          }
        | {
            wine_lists:
              | { id: string; restaurant_id: string }
              | { id: string; restaurant_id: string }[];
          }[];
    }>) {
      if (winePrice.has(item.wine_id)) continue;
      const sections = Array.isArray(item.wine_list_sections)
        ? item.wine_list_sections[0]
        : item.wine_list_sections;
      if (!sections) continue;
      const lists = Array.isArray(sections.wine_lists)
        ? sections.wine_lists[0]
        : sections.wine_lists;
      if (lists?.restaurant_id !== restaurantId) continue;
      if (item.glass_price == null || item.glass_pour_ml == null) continue;
      winePrice.set(item.wine_id, {
        glassPrice: item.glass_price,
        pourMl: item.glass_pour_ml,
      });
    }

    const revenueByWine = new Map<string, number>();
    for (const event of pourEvents) {
      if (event.kind !== "pour" || event.ml_delta <= 0) continue;
      const price = winePrice.get(event.wine_id);
      if (!price) continue;
      revenueByWine.set(
        event.wine_id,
        (revenueByWine.get(event.wine_id) ?? 0) +
          price.glassPrice * (event.ml_delta / price.pourMl),
      );
    }

    const topWinesByRevenue = Array.from(revenueByWine.entries())
      .sort(function (a, b) { return b[1] - a[1]; })
      .slice(0, topN)
      .map(function (_a) {
        var wineId = _a[0];
        var revenue = _a[1];
        const wine = pourEvents.find(function (e) { return e.wine_id === wineId; });
        const w = wine?.wines as
          | { name: string; producer: string; vintage: number | null }
          | undefined;
        return {
          wine_id: wineId,
          name: w?.name ?? "Unknown",
          producer: w?.producer ?? "Unknown",
          vintage: w?.vintage ?? null,
          revenue: Math.round(revenue * 100) / 100,
          pour_count: pourCountByWine.get(wineId) ?? 0,
        };
      });

    return NextResponse.json({
      range,
      topN,
      totalPours: pourEvents.filter(function (e) { return e.kind === "pour"; }).length,
      pourVolumeBySection,
      topWinesByPours,
      topWinesByRevenue,
    });
  } catch (err) {
    Sentry.captureException(err, {
      tags: { surface: "insights", phase: "pour-analytics" },
      extra: { restaurantId, range, topN },
    });
    return NextResponse.json(
      { error: "Failed to load pour analytics." },
      { status: 500 },
    );
  }
}
