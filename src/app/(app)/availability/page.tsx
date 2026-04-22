import { redirect } from "next/navigation";
import { requireMembership } from "@/lib/api/auth";
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
  if (auth && "status" in auth) {
    // requireMembership returned a NextResponse (401/403); route to login.
    redirect("/login?next=/availability");
  }
  // Narrow: the guard above eliminates the NextResponse branch.
  const { supabase, restaurantId, role } = auth as Exclude<typeof auth, Response>;

  // See /api/wines/availability for why we don't embed auth.users here.
  const { data } = await supabase
    .from("wines")
    .select(
      "id, name, producer, vintage, varietal, region, is_eightysixed, eightysixed_at, eightysixed_by",
    )
    .eq("restaurant_id", restaurantId)
    .order("name", { ascending: true });

  // Cast via unknown: the generated types lag behind migration 0015 until
  // `supabase gen types` runs against prod in CI (see architecture_index.md).
  const rows: WineAvailabilityRow[] = (data ?? []) as unknown as WineAvailabilityRow[];

  const canToggle = role === "owner" || role === "manager";

  return (
    <main className="mx-auto max-w-[960px] px-lg py-xl">
      <header className="mb-xl">
        <h1 className="font-serif text-[28px] text-ink">Availability</h1>
        <p className="mt-xs text-[14px] text-ink-muted">
          Toggle a wine off when you run out; guests stop seeing it on your
          published lists within seconds.
        </p>
      </header>
      <AvailabilityList initialRows={rows} canToggle={canToggle} />
    </main>
  );
}
