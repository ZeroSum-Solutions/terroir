import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, History } from "lucide-react";
import { getAuthContext } from "@/lib/auth-context";
import { ReconcileList } from "../reconcile-list";
import type { OpenBottleRow } from "@/lib/wine-list/shapes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Reconcile — Terroir" };

/**
 * /cellar/reconcile — BND-128 / BND-135
 *
 * Dedicated end-of-shift reconciliation page. Gated to manager+ only;
 * staff are redirected to /cellar with a 403-like UX.
 *
 * Renders the ReconcileList component (shared with the ReconcileModal)
 * in a full-page layout with a back button to /cellar and a link to
 * the reconciliation history view (BND-135).
 */
export default async function ReconcilePage() {
  const auth = await getAuthContext();
  if (!auth) redirect("/login");

  const { supabase, restaurantId, userRole } = auth;

  // Role gate: manager or owner only
  if (userRole !== "owner" && userRole !== "manager") {
    redirect("/cellar");
  }

  // Fetch open bottles for reconciliation (same query as cellar/page.tsx)
  const { data: openBottleRows } = await supabase.rpc(
    "list_open_bottle_items",
    { p_restaurant_id: restaurantId },
  );

  const reconcileItems: OpenBottleRow[] = (
    (openBottleRows ?? []) as OpenBottleRow[]
  ).filter((i) => i.open_remaining_ml !== null);

  // Fetch reconcile variance threshold from config
  const { data: configRow } = await supabase
    .from("cellar_config")
    .select("reconcile_variance_threshold_oz")
    .eq("restaurant_id", restaurantId)
    .limit(1)
    .maybeSingle();

  const varianceThresholdOz = configRow?.reconcile_variance_threshold_oz ?? 1.0;

  return (
    <section>
      <header className="mb-lg flex items-center gap-sm">
        <Link
          href="/cellar"
          className="flex h-[44px] w-[44px] items-center justify-center rounded-pill text-grey hover:bg-bridge-surface transition-colors"
          aria-label="Back to cellar"
        >
          <ArrowLeft className="h-5 w-5" strokeWidth={2} />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="font-serif text-heading-sm md:text-heading font-medium text-ink">Reconcile</h1>
          <p className="text-[12px] text-grey tabular">
            {reconcileItems.length} open bottle
            {reconcileItems.length !== 1 ? "s" : ""} to verify
          </p>
        </div>
        <Link
          href="/cellar/reconcile/history"
          className="flex min-h-11 items-center gap-xs rounded-pill border border-ink/25 bg-surface px-sm text-[13px] font-medium text-grey transition-colors hover:bg-bridge-surface hover:text-ink"
        >
          <History className="h-4 w-4" strokeWidth={1.5} />
          <span className="hidden sm:inline">History</span>
        </Link>
      </header>

      <ReconcileList
        initialItems={reconcileItems}
        varianceThresholdOz={varianceThresholdOz}
      />
    </section>
  );
}
