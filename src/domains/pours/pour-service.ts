import * as Sentry from "@sentry/nextjs";
import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { revalidateAutoEightysixedWines } from "@/lib/api/auto-eightysix-revalidation";
import type { Database } from "@/types/database";

export class PourNoInventoryError extends Error {
  constructor() {
    super("No inventory available.");
    this.name = "PourNoInventoryError";
  }
}

export class PourForbiddenError extends Error {
  constructor() {
    super("Forbidden.");
    this.name = "PourForbiddenError";
  }
}

export class PourRpcError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "PourRpcError";
    this.cause = options?.cause;
  }
}

export type RecordPourInput = {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  wineId: string;
  ml: number;
  kind: "pour" | "spill";
  note?: string;
};

export async function recordPour(input: RecordPourInput) {
  const { supabase, restaurantId, wineId, ml, kind, note } = input;
  const sinceTs = new Date().toISOString();

  const { data, error } = await supabase.rpc("record_pour", {
    p_wine_id: wineId,
    p_ml: ml,
    p_kind: kind,
    p_note: (note ?? null) as unknown as string,
  });

  if (error) {
    if (
      error.code === "P0001" &&
      String(error.message ?? "").includes("TERROIR_OUT_OF_STOCK")
    ) {
      throw new PourNoInventoryError();
    }
    if (error.code === "42501") {
      throw new PourForbiddenError();
    }
    console.error("record_pour failed:", error);
    Sentry.captureException(error, {
      tags: { surface: "pour", phase: "record_pour-rpc" },
      extra: { wine_id: wineId, ml, kind },
    });
    throw new PourRpcError("Pour failed.", { cause: error });
  }

  revalidatePath("/availability");

  await revalidateAutoEightysixedWines({
    supabase,
    restaurantId,
    touchedWineIds: [wineId],
    sinceTs,
  });

  return data;
}

