import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import * as Sentry from "@sentry/nextjs";
import { Errors } from "@/lib/api/errors";
import { z } from "zod";
import { requireMembership } from "@/lib/api/auth";
import { revalidateAutoEightysixedWines } from "@/lib/api/auto-eightysix-revalidation";

export const runtime = "nodejs";

const EntrySchema = z.object({
  wine_id: z.string().uuid(),
  // Upper bound is a sanity check against garbage (20L = larger than any
  // real bottle — Imperial is 6L). The per-wine size_ml check lives in
  // the RPC and raises P0002 → 400 EXCEEDS_SIZE.
  new_remaining_ml: z.number().int().min(0).max(20000),
  note: z.string().trim().max(500).optional(),
});

const BodySchema = z.object({
  entries: z.array(EntrySchema).min(1).max(100),
});

/**
 * POST /api/reconcile
 *
 * BND-038. End-of-shift reconcile: batch-update open_bottles.remaining_ml
 * to match physical reality. Each entry becomes a `reconcile` pour_event
 * inserted by reconcile_open_bottle inside reconcile_open_bottles_batch —
 * the whole set runs in one PL/pgSQL transaction, so partial-apply is
 * impossible and retries are idempotent (a failed batch rolls back every
 * entry, not just the failing one).
 *
 * Role-gated inside the per-entry RPC to owner | manager.
 *
 * 200: { updated: N }
 * 400: invalid body / empty entries / > 100 entries / remaining_ml > size_ml
 * 401: unauthenticated (from requireMembership)
 * 403: role mismatch (reported by RPC as 42501)
 * 500: unhandled RPC failure
 */
export async function POST(request: NextRequest) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Errors.badRequest("Invalid JSON.");
  }

  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return Errors.validation(parsed.error.issues, "Invalid body.");
  }

  // ARCH-023: capture timestamp BEFORE the batch write so we can
  // detect auto-86 events inserted by the pour_events trigger (each
  // reconcile entry creates a pour_event that can cascade through
  // the auto-86 trigger).
  const sinceTs = new Date().toISOString();

  // Send entries as a JSON array to the batch RPC. The RPC iterates
  // inside one transaction and returns the count on success.
  const { data, error } = await supabase.rpc(
    "reconcile_open_bottles_batch",
    {
      p_entries: parsed.data.entries as unknown as import("@/types/database").Json,
    },
  );

  if (error) {
    if (error.code === "42501") {
      return Errors.forbidden("Forbidden.");
    }
    if (error.code === "P0002") {
      // "new_remaining_ml exceeds bottle size" — caller sent a bad
      // value. Surface as 400 so the UI can show "that's more than a
      // 750ml bottle can hold."
      return Errors.badRequest("new_remaining_ml exceeds bottle size.", undefined, "EXCEEDS_SIZE");
    }
    console.error("reconcile_open_bottles_batch failed:", error);
    Sentry.captureException(error, {
      tags: { surface: "reconcile", phase: "reconcile_open_bottles_batch-rpc" },
      extra: { entry_count: parsed.data.entries.length },
    });
    return Errors.internal("Reconcile failed.");
  }

  revalidatePath("/availability");

  // ARCH-023: if any entry's pour_event cascaded into an auto-86
  // via the migration-0021 trigger, revalidate every published
  // /list/[slug] that references it.
  const touchedWineIds = Array.from(
    new Set(parsed.data.entries.map((e) => e.wine_id)),
  );
  await revalidateAutoEightysixedWines({
    supabase,
    restaurantId,
    touchedWineIds,
    sinceTs,
  });

  return NextResponse.json({ updated: (data as number) ?? 0 });
}
