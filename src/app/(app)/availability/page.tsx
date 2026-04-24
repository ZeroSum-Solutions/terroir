import { NextResponse } from "next/server";
import { redirect } from "next/navigation";
import { requireMembership } from "@/lib/api/auth";
import { AutoEightysixPanel } from "./auto-eightysix-panel";
import { AvailabilityList } from "./availability-list";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type WineAvailabilityRow = {
  id: string;
  name: string;
  producer: string;
  vintage: number | null;
  varietal: string | null;
  region: string | null;
  is_eightysixed: boolean;
  eightysixed_at: string | null;
  eightysixed_by: string | null;
};

export default async function AvailabilityPage() {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) {
    // requireMembership returned a NextResponse (401/403); route to login.
    redirect("/login?next=/availability");
  }
  const { supabase, restaurantId, role } = auth;

  // BND-037b: fetch the wine list + the auto-86 restaurant config in
  // parallel. Only owners see the config panel (PATCH is owner-gated).
  const [{ data: wineRows }, { data: restaurantRow }] = await Promise.all([
    supabase
      .from("wines")
      .select(
        "id, name, producer, vintage, varietal, region, is_eightysixed, eightysixed_at, eightysixed_by",
      )
      .eq("restaurant_id", restaurantId)
      .order("name", { ascending: true }),
    supabase
      .from("restaurants")
      .select("auto_eightysix_from_inventory, eightysix_ml_threshold")
      .eq("id", restaurantId)
      .single(),
  ]);

  const rows: WineAvailabilityRow[] = wineRows ?? [];

  const canToggle = role === "owner" || role === "manager";
  const isOwner = role === "owner";

  return (
    <main className="mx-auto max-w-[960px] px-lg py-xl">
      <header className="mb-xl">
        <h1 className="font-serif text-[28px] text-ink">Availability</h1>
        <p className="mt-xs text-[14px] text-ink-muted">
          Toggle a wine off when you run out; guests stop seeing it on your
          published lists within seconds.
        </p>
      </header>

      {isOwner && restaurantRow && (
        <AutoEightysixPanel
          restaurantId={restaurantId}
          enabled={restaurantRow.auto_eightysix_from_inventory ?? false}
          thresholdMl={restaurantRow.eightysix_ml_threshold ?? 148}
        />
      )}

      <AvailabilityList initialRows={rows} canToggle={canToggle} />
    </main>
  );
}
