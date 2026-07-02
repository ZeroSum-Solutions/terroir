import { NextResponse, type NextRequest } from "next/server";
import { Errors } from "@/lib/api/errors";
import { z } from "zod";
import {
  ReconcileExceedsSizeError,
  ReconcileForbiddenError,
  ReconcileRpcError,
  reconcileOpenBottles,
} from "@/domains/cellar/reconcile-service";
import { requireRole } from "@/lib/api/auth";

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
 * BND-038 / BND-136. End-of-shift reconcile: batch-update open_bottles.remaining_ml
 * to match physical reality. Each entry becomes a `reconcile` pour_event
 * inserted by reconcile_open_bottle inside reconcile_open_bottles_batch —
 * the whole set runs in one PL/pgSQL transaction, so partial-apply is
 * impossible and retries are idempotent (a failed batch rolls back every
 * entry, not just the failing one).
 *
 * Role-gated to owner | manager via requireRole (endpoint-level 403 for staff).
 * The RPC also enforces role as defense-in-depth.
 *
 * 200: { updated: N }
 * 400: invalid body / empty entries / > 100 entries / remaining_ml > size_ml
 * 401: unauthenticated (from requireRole)
 * 403: role mismatch (staff rejected at endpoint; manager/owner required)
 * 500: unhandled RPC failure
 */
export async function POST(request: NextRequest) {
  const auth = await requireRole(["owner", "manager"]);
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

  try {
    const updated = await reconcileOpenBottles({
      supabase,
      restaurantId,
      entries: parsed.data.entries,
    });
    return NextResponse.json({ updated });
  } catch (error) {
    if (error instanceof ReconcileForbiddenError) {
      return Errors.forbidden("Forbidden.");
    }
    if (error instanceof ReconcileExceedsSizeError) {
      // "new_remaining_ml exceeds bottle size" — caller sent a bad
      // value. Surface as 400 so the UI can show "that's more than a
      // 750ml bottle can hold."
      return Errors.badRequest("new_remaining_ml exceeds bottle size.", undefined, "EXCEEDS_SIZE");
    }
    if (error instanceof ReconcileRpcError) {
      return Errors.internal("Reconcile failed.");
    }
    throw error;
  }
}
