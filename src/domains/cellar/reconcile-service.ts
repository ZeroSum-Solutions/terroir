import * as Sentry from "@sentry/nextjs";
import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { revalidateAutoEightysixedWines } from "@/lib/api/auto-eightysix-revalidation";
import type { Database, Json } from "@/types/database";

export class ReconcileForbiddenError extends Error {
  constructor() {
    super("Forbidden.");
    this.name = "ReconcileForbiddenError";
  }
}

export class ReconcileExceedsSizeError extends Error {
  constructor() {
    super("new_remaining_ml exceeds bottle size.");
    this.name = "ReconcileExceedsSizeError";
  }
}

export class ReconcileRpcError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "ReconcileRpcError";
    this.cause = options?.cause;
  }
}

export type ReconcileEntry = {
  wine_id: string;
  new_remaining_ml: number;
  note?: string;
};

export type ReconcileOpenBottlesInput = {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  entries: ReconcileEntry[];
};

export async function reconcileOpenBottles(
  input: ReconcileOpenBottlesInput,
): Promise<number> {
  const { supabase, restaurantId, entries } = input;
  const sinceTs = new Date().toISOString();

  const { data, error } = await supabase.rpc(
    "reconcile_open_bottles_batch",
    {
      p_entries: entries as unknown as Json,
    },
  );

  if (error) {
    if (error.code === "42501") {
      throw new ReconcileForbiddenError();
    }
    if (error.code === "P0002") {
      throw new ReconcileExceedsSizeError();
    }
    console.error("reconcile_open_bottles_batch failed:", error);
    Sentry.captureException(error, {
      tags: { surface: "reconcile", phase: "reconcile_open_bottles_batch-rpc" },
      extra: { entry_count: entries.length },
    });
    throw new ReconcileRpcError("Reconcile failed.", { cause: error });
  }

  revalidatePath("/availability");

  const touchedWineIds = Array.from(new Set(entries.map((entry) => entry.wine_id)));
  await revalidateAutoEightysixedWines({
    supabase,
    restaurantId,
    touchedWineIds,
    sinceTs,
  });

  return (data as number) ?? 0;
}

