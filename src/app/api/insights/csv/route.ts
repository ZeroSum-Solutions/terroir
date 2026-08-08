import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireMembership } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import {
  dateRangeSince,
  dateRangeUntil,
  isValidCustomDateRange,
} from "@/app/(app)/insights/date-range";
import { summarizeLineItemCorrections } from "@/lib/insights/analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function escapeField(value: string): string {
  const neutralized = /^\s*[=+\-@]/.test(value) ? `'${value}` : value;
  if (
    neutralized.includes(",") ||
    neutralized.includes('"') ||
    neutralized.includes("\n") ||
    neutralized.includes("\r")
  ) {
    return `"${neutralized.replace(/"/g, '""')}"`;
  }
  return neutralized;
}

function formatMoney(n: number): string {
  return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

/**
 * GET /api/insights/csv — export the insights view as CSV.
 *
 * Columns match the visible panels on /insights: Date, Distributor,
 * Items Scanned, Accuracy, Value. Includes distributor breakdown
 * and varietal breakdown sections.
 */
export async function GET(request?: Request) {
  return withApiHandler(() => getInsightsCsv(request));
}

async function getInsightsCsv(request?: Request) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;
  const searchParams = request ? new URL(request.url).searchParams : null;
  const range = searchParams?.get("range") ?? "all";
  const from = searchParams?.get("from") ?? undefined;
  const to = searchParams?.get("to") ?? undefined;
  if (range === "custom" && !isValidCustomDateRange(from, to)) {
    return Errors.badRequest(
      "Invalid custom date range.",
      undefined,
      "invalid_date_range",
    );
  }
  const rangeSince = dateRangeSince(range, from);
  const rangeUntil = dateRangeUntil(range, to);

  try {
    let scanQuery = supabase
      .from("invoice_scans")
      .select(
        "id, distributor_name, item_count, edits, created_at, final_line_items",
      )
      .eq("restaurant_id", restaurantId)
      .order("created_at", { ascending: false });
    const inventoryQuery = supabase
      .from("inventory_items")
      .select("quantity, unit_cost, wine_id, wines(varietal)")
      .eq("restaurant_id", restaurantId);
    let scanItemsQuery = supabase
      .from("inventory_items")
      .select(
        "quantity, unit_cost, invoice_scan_id, invoice_scans!inner(distributor_name, created_at)",
      )
      .eq("restaurant_id", restaurantId);

    if (rangeSince) {
      const since = rangeSince.toISOString();
      scanQuery = scanQuery.gte("created_at", since);
      scanItemsQuery = scanItemsQuery.gte("invoice_scans.created_at", since);
    }
    if (rangeUntil) {
      const until = rangeUntil.toISOString();
      scanQuery = scanQuery.lte("created_at", until);
      scanItemsQuery = scanItemsQuery.lte("invoice_scans.created_at", until);
    }

    // Fetch the same data as the insights page
    const [
      { data: scans, error: scansError },
      { data: inventoryItems, error: inventoryError },
      { data: scanItems, error: scanItemsError },
    ] = await Promise.all([
      scanQuery,
      inventoryQuery,
      scanItemsQuery,
    ]);
    if (scansError) throw scansError;
    if (inventoryError) throw inventoryError;
    if (scanItemsError) throw scanItemsError;

    const allScans = scans ?? [];
    const items = inventoryItems ?? [];

    const lines: string[] = [];

    // ── Section 1: Scan Activity ──────────────────────────────────────
    lines.push("=== SCAN ACTIVITY ===");
    lines.push(
      "Date,Distributor,Items Scanned,Auto-Accepted Items,Corrected Items,Accuracy,Value",
    );

    for (const scan of allScans) {
      const lineItems = (scan.final_line_items ?? []) as Array<{
        qty?: number;
        unitCost?: number;
      }>;
      const scanValue = lineItems.reduce(
        (sum, it) => sum + (it.qty ?? 0) * (it.unitCost ?? 0),
        0,
      );
      const correctionSummary = summarizeLineItemCorrections([scan]);
      const accuracyPct = correctionSummary.accuracyPct + "%";

      const date = new Date(scan.created_at).toISOString().split("T")[0];

      lines.push(
        [
          date,
          escapeField(scan.distributor_name),
          scan.item_count,
          correctionSummary.autoAccepted,
          correctionSummary.corrected,
          accuracyPct,
          scanValue > 0 ? formatMoney(scanValue) : "",
        ].join(","),
      );
    }

    lines.push("");

    // ── Section 2: Distributor Breakdown ──────────────────────────────
    const distMap = new Map<string, { scans: number; spend: number }>();
    for (const scan of allScans) {
      const existing = distMap.get(scan.distributor_name) ?? { scans: 0, spend: 0 };
      existing.scans += 1;
      distMap.set(scan.distributor_name, existing);
    }
    for (const item of scanItems ?? []) {
      const distName = (
        item.invoice_scans as { distributor_name: string; created_at: string }
      )?.distributor_name;
      if (!distName) continue;
      const existing = distMap.get(distName) ?? { scans: 0, spend: 0 };
      existing.spend += item.quantity * item.unit_cost;
      distMap.set(distName, existing);
    }
    const distTotalSpend =
      [...distMap.values()].reduce((s, d) => s + d.spend, 0) || 1;

    lines.push("=== DISTRIBUTOR BREAKDOWN ===");
    lines.push("Distributor,Scans,Spend,Share");

    const distributors = [...distMap.entries()]
      .sort((a, b) => b[1].spend - a[1].spend);

    for (const [name, data] of distributors) {
      const pct = Math.round((data.spend / distTotalSpend) * 100);
      lines.push(
        [
          escapeField(name),
          data.scans,
          formatMoney(data.spend),
          pct + "%",
        ].join(","),
      );
    }

    lines.push("");

    // ── Section 3: Varietal Breakdown ─────────────────────────────────
    const varietalMap = new Map<string, number>();
    for (const item of items) {
      const varietal =
        (item.wines as { varietal: string | null } | null)?.varietal ?? "Other";
      varietalMap.set(
        varietal,
        (varietalMap.get(varietal) ?? 0) + item.quantity * item.unit_cost,
      );
    }
    const varietalTotal =
      [...varietalMap.values()].reduce((s, v) => s + v, 0) || 1;

    lines.push("=== VARIETAL BREAKDOWN ===");
    lines.push("Varietal,Value,Share");

    const varietals = [...varietalMap.entries()]
      .sort((a, b) => b[1] - a[1]);

    for (const [name, value] of varietals) {
      const pct = Math.round((value / varietalTotal) * 100);
      lines.push(
        [escapeField(name), formatMoney(value), pct + "%"].join(","),
      );
    }

    const csv = lines.join("\n");

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="insights-export.csv"',
      },
    });
  } catch (err) {
    Sentry.captureException(err, {
      tags: { surface: "insights", phase: "csv-export" },
      extra: { restaurantId },
    });
    return Errors.internal("Failed to generate CSV export.");
  }
}
