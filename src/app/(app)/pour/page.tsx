import { redirect } from "next/navigation";
import { requireMembership } from "@/lib/api/auth";
import { PourList } from "./pour-list";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type PourItem = {
  wine_list_item_id: string;
  wine_id: string;
  name: string;
  producer: string;
  vintage: number | null;
  size_ml: number;
  glass_pour_ml: number;
  pour_size_mode: "fixed" | "picker";
  open_remaining_ml: number | null;
  opened_at: string | null;
  sealed_count: number;
};

// BND-038. Primary tap-per-pour UI. Mobile-first per CLAUDE.md:
// single-column stacked cards on phone, 2-col grid at md+.
export default async function PourPage() {
  const auth = await requireMembership();
  if (auth && "status" in auth) {
    redirect("/login?next=/pour");
  }
  const { supabase, restaurantId } =
    auth as Exclude<typeof auth, Response>;

  const { data } = await supabase.rpc("list_open_bottle_items", {
    p_restaurant_id: restaurantId,
  });

  const items = ((data ?? []) as unknown as PourItem[]).filter(
    (i) => i.glass_pour_ml !== null,
  );

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
