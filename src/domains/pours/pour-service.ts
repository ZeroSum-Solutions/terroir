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

export type RevalidateUndonePourInput = {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  wineId: string;
  sinceTs: string;
};

export async function revalidateUndonePour(
  input: RevalidateUndonePourInput,
) {
  const { supabase, restaurantId, wineId, sinceTs } = input;
  revalidatePath("/availability");

  await revalidateAutoEightysixedWines({
    supabase,
    restaurantId,
    touchedWineIds: [wineId],
    sinceTs,
  });
}
