/**
 * Pure state-machine that mirrors the `record_pour` SQL RPC
 * (supabase/migrations/0016_pour_tracking.sql).
 *
 * Used by the pour list's optimistic UI so the client converges with
 * the ledger before router.refresh lands. Any behavioural drift from
 * the RPC shows up as a flicker in the UI, so the rules below must
 * track 0016 exactly.
 *
 * RPC summary (successful paths only; OUT_OF_STOCK is P0001):
 *   - No open bottle, no sealed stock         → OUT_OF_STOCK.
 *   - No open bottle, sealed available        → open fresh; remaining
 *     becomes size_ml - ml (if size_ml >= ml), sealed decrements by 1.
 *     If ml > size_ml the RPC cascades again (finish new, open next,
 *     pour) so two sealed are consumed — but pour sizes are oz-scale
 *     and bottle sizes are hundreds of ml, so this path is practically
 *     unreachable. We treat the single-bottle case as the norm and
 *     still return a cascade; router.refresh corrects the rare double.
 *   - Open, remaining >= ml                   → simple subtract.
 *   - Open, remaining < ml, sealed available  → finish + new + pour;
 *     remaining becomes size_ml - ml, sealed decrements by 1.
 *   - Open, remaining < ml, no sealed         → OUT_OF_STOCK.
 */

export type PourPrediction =
  | {
      /** Simple pour from the currently-open bottle. */
      kind: "partial";
      openRemainingMl: number;
      sealedCountAfter: number;
    }
  | {
      /**
       * Either we opened a new bottle from sealed stock to start the
       * pour, or we finished the open bottle mid-pour and opened the
       * next one. Either way, a bottle transition happened.
       */
      kind: "cascade";
      openRemainingMl: number;
      sealedCountAfter: number;
    }
  | { kind: "out_of_stock" };

export interface PourInput {
  /** `null` means no open bottle exists yet. */
  openRemainingMl: number | null;
  /** Full-bottle size in ml (e.g. 750). */
  sizeMl: number;
  /** Sealed bottles in inventory (not counting the open one). */
  sealedCount: number;
  /** Pour amount in ml; must be positive. */
  mlPoured: number;
}

export function predictOpenBottleAfterPour(input: PourInput): PourPrediction {
  const { openRemainingMl, sizeMl, sealedCount, mlPoured } = input;

  // No open bottle. We need sealed stock to start anything.
  if (openRemainingMl === null) {
    if (sealedCount <= 0) {
      return { kind: "out_of_stock" };
    }
    // Open a fresh bottle (RPC inserts new_bottle → remaining = size_ml),
    // then pour from it. The overage edge (ml > size_ml, needs 2 sealed)
    // is documented above; we approximate with clamp-to-0 and let
    // router.refresh reconcile.
    return {
      kind: "cascade",
      openRemainingMl: Math.max(0, sizeMl - mlPoured),
      sealedCountAfter: sealedCount - 1,
    };
  }

  // Enough in the open bottle: straight subtract.
  if (openRemainingMl >= mlPoured) {
    return {
      kind: "partial",
      openRemainingMl: openRemainingMl - mlPoured,
      sealedCountAfter: sealedCount,
    };
  }

  // Overage with sealed stock: finish + new + pour.
  if (sealedCount > 0) {
    return {
      kind: "cascade",
      openRemainingMl: Math.max(0, sizeMl - mlPoured),
      sealedCountAfter: sealedCount - 1,
    };
  }

  // Overage, no replacement available.
  return { kind: "out_of_stock" };
}
