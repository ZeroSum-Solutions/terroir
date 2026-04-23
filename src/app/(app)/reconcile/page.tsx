import { redirect } from "next/navigation";
import { requireMembership } from "@/lib/api/auth";
import { ReconcileList } from "./reconcile-list";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type ReconcileItem = {
  wine_id: string;
  name: string;
  producer: string;
  vintage: number | null;
  size_ml: number;
  open_remaining_ml: number;
  glass_pour_ml: number;
};

// BND-038. End-of-shift correction UI. Owner + manager only (staff
// lands back on /pour). Lists every currently-open bottle and lets
// the manager snap to a fraction or type an exact ml value.
export default async function ReconcilePage() {
  const auth = await requireMembership();
  if (auth && "status" in auth) {
    redirect("/login?next=/reconcile");
  }
  const { supabase, restaurantId, role } =
    auth as Exclude<typeof auth, Response>;

  if (role !== "owner" && role !== "manager") {
    redirect("/pour");
  }

  const { data } = await supabase.rpc("list_open_bottle_items", {
    p_restaurant_id: restaurantId,
  });

  type RawRow = Omit<ReconcileItem, "open_remaining_ml"> & {
    open_remaining_ml: number | null;
  };

  const items: ReconcileItem[] = ((data ?? []) as unknown as RawRow[])
    .filter((i): i is ReconcileItem => i.open_remaining_ml !== null)
    .map((i) => ({
      wine_id: i.wine_id,
      name: i.name,
      producer: i.producer,
      vintage: i.vintage,
      size_ml: i.size_ml,
      open_remaining_ml: i.open_remaining_ml,
      glass_pour_ml: i.glass_pour_ml,
    }));

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
