import * as Sentry from "@sentry/nextjs";
import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

type Client = SupabaseClient<Database>;

/**
 * ARCH-023: after a pour or reconcile, the BND-037b auto-86 trigger
 * may have flipped `wines.is_eightysixed` to true server-side. The
 * manual-86 flow (`/api/wines/[id]/availability`) calls
 * `wine_published_list_slugs` + `revalidatePath('/list/<slug>')` to
 * keep public menus fresh — but the pour/reconcile flows didn't, so
 * an auto-86'd wine could linger on public menus up to the ISR TTL.
 *
 * Detection strategy: the auto-86 trigger inserts a row into
 * `availability_events` with `user_id = null` and
 * `direction = 'eightysixed'` (see migration 0021). We query for any
 * such rows that landed AFTER the caller started the write — those
 * are exactly the wines that just flipped to 86'd as a side-effect
 * of this request.
 *
 * The caller captures `sinceTs` BEFORE initiating the write, passes
 * the touched wine IDs, and calls this helper AFTER the write
 * succeeds.
 *
 * Failure mode: this helper is best-effort. A failed lookup or
 * revalidate is logged to the console but does NOT propagate — we
 * don't want a stale-menu risk to break a pour. The worst case is
 * the menu stays stale until the ISR TTL expires.
 */
export async function revalidateAutoEightysixedWines(params: {
  supabase: Client;
  restaurantId: string;
  touchedWineIds: string[];
  sinceTs: string;
}): Promise<void> {
  const { supabase, restaurantId, touchedWineIds, sinceTs } = params;
  if (touchedWineIds.length === 0) return;

  const { data: events, error } = await supabase
    .from("availability_events")
    .select("wine_id")
    .eq("restaurant_id", restaurantId)
    .eq("direction", "eightysixed")
    .is("user_id", null)
    .gte("created_at", sinceTs)
    .in("wine_id", touchedWineIds);

  if (error) {
    console.error(
      "auto-86 revalidation: failed to read availability_events:",
      error,
    );
    Sentry.captureException(error, {
      tags: { surface: "auto-eightysix", phase: "events-select" },
      extra: { restaurant_id: restaurantId, wine_count: touchedWineIds.length },
    });
    return;
  }

  const newlyAutoEightysixed = Array.from(
    new Set((events ?? []).map((r) => r.wine_id)),
  );

  // PERF: issue every slug lookup concurrently instead of one-at-a-time.
  // wine_published_list_slugs has no batched (array-of-ids) variant to
  // call in a single round trip, so this stays N requests — but they now
  // overlap instead of serializing N round-trip latencies.
  const slugLookups = await Promise.all(
    newlyAutoEightysixed.map((wineId) =>
      // Same RPC the manual-86 flow uses (migration 0019). SECURITY
      // DEFINER + internal is_member check, so RLS doesn't filter it.
      supabase
        .rpc("wine_published_list_slugs", {
          p_wine_id: wineId,
          p_restaurant_id: restaurantId,
        })
        .then((result) => ({ wineId, ...result })),
    ),
  );

  for (const { wineId, data: slugs, error: slugsError } of slugLookups) {
    if (slugsError) {
      console.error(
        "auto-86 revalidation: wine_published_list_slugs failed:",
        slugsError,
      );
      Sentry.captureException(slugsError, {
        tags: { surface: "auto-eightysix", phase: "slugs-rpc" },
        extra: { wine_id: wineId, restaurant_id: restaurantId },
      });
      continue;
    }

    for (const row of (slugs ?? []) as Array<{ slug: string }>) {
      revalidatePath(`/list/${row.slug}`);
    }
  }
}
