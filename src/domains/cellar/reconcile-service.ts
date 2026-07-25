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

export class ReconcileNotFoundError extends Error {
  constructor() {
    super("Open bottle not found.");
    this.name = "ReconcileNotFoundError";
  }
}

export class ReconcileRpcError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "ReconcileRpcError";
    this.cause = options?.cause;
  }
}

export class ReconcileInvalidRequestError extends Error {
  constructor() {
    super("Invalid reconcile request.");
    this.name = "ReconcileInvalidRequestError";
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
  idempotencyKey: string | null;
  requestHash: string | null;
};

export async function reconcileOpenBottles(
  input: ReconcileOpenBottlesInput,
): Promise<unknown> {
  const {
    supabase,
    restaurantId,
    entries,
    idempotencyKey,
    requestHash,
  } = input;
  const keyedArgs = idempotencyKey && requestHash
    ? {
        p_idempotency_key: idempotencyKey,
        p_request_hash: requestHash,
      }
    : {};

  const { data, error } = await supabase.rpc(
    "reconcile_open_bottles_idempotent",
    {
      p_restaurant_id: restaurantId,
      p_entries: entries as unknown as Json,
      ...keyedArgs,
    },
  );

  if (error) {
    if (error.code === "42501") {
      throw new ReconcileForbiddenError();
    }
    if (idempotencyKey && error.code === "22023") {
      throw new ReconcileInvalidRequestError();
    }
    if (error.code === "P0002") {
      throw new ReconcileExceedsSizeError();
    }
    const message = error.message?.trim().toLowerCase();
    if (
      error.code === "P0001" &&
      (message === "wine not found" ||
        message === "no open bottle for this wine")
    ) {
      throw new ReconcileNotFoundError();
    }
    captureReconcileError(error, "reconcile_open_bottles_idempotent-rpc", {
      entry_count: entries.length,
    });
    throw new ReconcileRpcError("Reconcile failed.", { cause: error });
  }

  return Array.isArray(data) ? data[0] : data;
}

export async function revalidateReconcileResult(input: {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  entries: ReconcileEntry[];
  sinceTs: string;
}): Promise<void> {
  const { supabase, restaurantId, entries, sinceTs } = input;

  try {
    revalidatePath("/availability");
  } catch (error) {
    captureReconcileError(error, "revalidate:/availability");
  }

  const touchedWineIds = Array.from(new Set(entries.map((entry) => entry.wine_id)));
  try {
    await revalidateAutoEightysixedWines({
      supabase,
      restaurantId,
      touchedWineIds,
      sinceTs,
    });
  } catch (error) {
    captureReconcileError(error, "revalidate:auto-eightysix", {
      entry_count: entries.length,
    });
  }
}

function captureReconcileError(
  error: unknown,
  phase: string,
  extra?: Record<string, unknown>,
): void {
  try {
    console.error(`reconcile ${phase} failed:`, error);
    Sentry.captureException(error, {
      tags: { surface: "reconcile", phase },
      ...(extra ? { extra } : {}),
    });
  } catch {
    // Observability and cache refresh cannot replace a committed response.
  }
}
