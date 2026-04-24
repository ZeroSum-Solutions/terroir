import { NextResponse } from "next/server";
import { redirect } from "next/navigation";
import { requireMembership } from "@/lib/api/auth";
import type { OpenBottleRow } from "@/lib/wine-list/shapes";
import { PourList } from "./pour-list";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Re-exported so client components in this route segment can keep
// a single stable import path. DEBT-022: the structural shape now
// lives in @/lib/wine-list/shapes.ts — see OpenBottleRow.
export type PourItem = OpenBottleRow;

// BND-038. Primary tap-per-pour UI. Mobile-first per CLAUDE.md:
// single-column stacked cards on phone, 2-col grid at md+.
export default async function PourPage() {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) {
    redirect("/login?next=/pour");
  }
  const { supabase, restaurantId } = auth;

  const { data } = await supabase.rpc("list_open_bottle_items", {
    p_restaurant_id: restaurantId,
  });

  const items = (data ?? []).filter((i) => i.glass_pour_ml !== null);

  return (
    <main className="mx-auto max-w-[960px] px-lg py-xl">
      <header className="mb-lg md:mb-xl">
        <h1 className="font-serif text-[28px] text-ink">Pour</h1>
        <p className="mt-xs text-[14px] text-ink-muted">
          Tap a wine to record a glass pour. The system opens a fresh
          bottle when the current one runs out.
        </p>
      </header>
      <PourList initialItems={items} />
    </main>
  );
}
