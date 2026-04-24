import { NextResponse } from "next/server";
import { redirect } from "next/navigation";
import { requireMembership } from "@/lib/api/auth";
import type { OpenBottleRow } from "@/lib/wine-list/shapes";
import { ReconcileList } from "./reconcile-list";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Re-exported for the client list component. DEBT-022: the shape
// now lives in @/lib/wine-list/shapes.ts — see OpenBottleRow.
export type ReconcileItem = OpenBottleRow;

// BND-038. End-of-shift correction UI. Owner + manager only (staff
// lands back on /pour). Lists every currently-open bottle and lets
// the manager snap to a fraction or type an exact ml value.
export default async function ReconcilePage() {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) {
    redirect("/login?next=/reconcile");
  }
  const { supabase, restaurantId, role } = auth;

  if (role !== "owner" && role !== "manager") {
    redirect("/pour");
  }

  const { data } = await supabase.rpc("list_open_bottle_items", {
    p_restaurant_id: restaurantId,
  });

  // Runtime filter: the RPC returns rows for every by-the-glass wine
  // including those with no open bottle yet. Reconcile only shows
  // rows with a currently-open bottle.
  const items = (data ?? []).filter((i) => i.open_remaining_ml !== null);

  return (
    <main className="mx-auto max-w-[720px] px-lg py-xl">
      <header className="mb-lg md:mb-xl">
        <h1 className="font-serif text-[28px] text-ink">Reconcile</h1>
        <p className="mt-xs text-[14px] text-ink-muted">
          End-of-shift correction. Set each open bottle to its actual
          remaining level.
        </p>
      </header>
      <ReconcileList initialItems={items} />
    </main>
  );
}
