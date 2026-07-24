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

export class PourNotFoundError extends Error {
  constructor(message = "Resource not found.") {
    super(message);
    this.name = "PourNotFoundError";
  }
}

export class PourAlreadyClosedError extends Error {
  constructor() {
    super("Bottle is already closed.");
    this.name = "PourAlreadyClosedError";
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
    p_restaurant_id: restaurantId,
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
    if (
      error.code === "P0001" &&
      error.message?.trim().toLowerCase() === "wine not found"
    ) {
      throw new PourNotFoundError("Wine not found.");
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

export type CloseOpenBottleInput = {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  bottleId: string;
};

export async function closeOpenBottle(input: CloseOpenBottleInput) {
  const { supabase, restaurantId, bottleId } = input;

  const { data: bottle, error: fetchError } = await supabase
    .from("open_bottles")
    .select("id, wine_id, remaining_ml, closed_at, restaurant_id")
    .eq("id", bottleId)
    .eq("restaurant_id", restaurantId)
    .single();

  if (
    fetchError &&
    (fetchError as { code?: string }).code !== "PGRST116"
  ) {
    throw fetchError;
  }
  if (!bottle) {
    throw new PourNotFoundError("Bottle not found.");
  }

  if (bottle.restaurant_id !== restaurantId) {
    throw new PourNotFoundError("Bottle not found.");
  }

  if (bottle.closed_at) {
    throw new PourAlreadyClosedError();
  }

  const closedAt = new Date().toISOString();
  const { error: pourError } = await supabase.rpc("record_pour", {
    p_restaurant_id: restaurantId,
    p_wine_id: bottle.wine_id,
    p_ml: bottle.remaining_ml,
    p_kind: "spill",
    p_note: "Bottle closed (discard remaining)",
  });

  if (pourError) {
    console.error("Failed to close bottle via record_pour:", pourError);
    Sentry.captureException(pourError, {
      tags: { surface: "open-bottles", phase: "close" },
      extra: { bottle_id: bottleId, wine_id: bottle.wine_id },
    });
    throw new PourRpcError("Failed to close bottle.", { cause: pourError });
  }

  revalidatePath("/cellar/open");

  return {
    id: bottle.id,
    wine_id: bottle.wine_id,
    closed_at: closedAt,
  };
}
