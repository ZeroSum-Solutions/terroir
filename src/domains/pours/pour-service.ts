import * as Sentry from "@sentry/nextjs";
import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { revalidateAutoEightysixedWines } from "@/lib/api/auto-eightysix-revalidation";
import type { Database } from "@/types/database";

export class PourForbiddenError extends Error {
  constructor() {
    super("Forbidden.");
    this.name = "PourForbiddenError";
  }
}

export class PourNotFoundError extends Error {
  constructor(message = "Resource not found.") {
    super(message);
    this.name = "PourNotFoundError";
  }
}

export class PourRpcError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "PourRpcError";
    this.cause = options?.cause;
  }
}

export async function revalidateRecordedPour(input: {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  wineId: string;
  sinceTs: string;
}) {
  const { supabase, restaurantId, wineId, sinceTs } = input;
  revalidatePath("/availability");

  await revalidateAutoEightysixedWines({
    supabase,
    restaurantId,
    touchedWineIds: [wineId],
    sinceTs,
  });
}

export type UndoLastPourInput = {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  wineId: string;
};

export async function undoLastPour(input: UndoLastPourInput) {
  const { supabase, restaurantId, wineId } = input;
  const sinceTs = new Date().toISOString();

  const { data, error } = await supabase.rpc("undo_last_pour", {
    p_restaurant_id: restaurantId,
    p_wine_id: wineId,
  });

  if (error) {
    const message = error.message?.trim().toLowerCase();
    if (
      error.code === "P0001" &&
      (message === "no recent pour to undo" || message === "wine not found")
    ) {
      throw new PourNotFoundError("Pour to undo not found.");
    }
    if (error.code === "42501") {
      throw new PourForbiddenError();
    }
    console.error("undo_last_pour failed:", error);
    Sentry.captureException(error, {
      tags: { surface: "pour", phase: "undo_last_pour-rpc" },
      extra: { wine_id: wineId },
    });
    throw new PourRpcError("Undo failed.", { cause: error });
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
