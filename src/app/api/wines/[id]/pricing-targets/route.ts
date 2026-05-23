import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { requireMembership } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";

export const runtime = "nodejs";

/**
 * BND-040 follow-up — PATCH /api/wines/[id]/pricing-targets
 *
 * Sets per-wine overrides for pour cost % target and markup × target.
 * Allocation wines (Krug, DRC) typically need lower markup than the
 * house default, and this endpoint is the only way to set that.
 *
 * Body: { pour_cost_pct?: number | null, markup_ratio?: number | null }
 *   • Numbers: set the override.
 *   • null:     clear the override (revert to restaurant default).
 *   • Omitted:  leave that column unchanged.
 *
 * Range mirrors the DB CHECK constraints from migration 0026:
 *   pour_cost_pct: > 0 AND < 100
 *   markup_ratio:  >= 1 AND <= 10
 *
 * Auth: owner+manager only. Mirrors snooze-alert + enrich endpoints.
 */
const PatchSchema = z
  .object({
    pour_cost_pct: z.number().gt(0).lt(100).nullable().optional(),
    markup_ratio: z.number().gte(1).lte(10).nullable().optional(),
  })
  .strict();

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId, role } = auth;

  if (role !== "owner" && role !== "manager") {
    return Errors.forbidden("Setting pricing targets requires owner or manager role.");
  }

  const { id } = await ctx.params;
  if (!id) {
    return Errors.badRequest("wine id required");
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Errors.badRequest("Invalid JSON.");
  }

  const parsed = PatchSchema.safeParse(raw);
  if (!parsed.success) {
    return Errors.validation(parsed.error.issues, "Invalid body.");
  }

  if (Object.keys(parsed.data).length === 0) {
    return Errors.badRequest("No valid fields.");
  }

  // Build update payload — only include fields that were sent.
  const update: {
    pricing_target_pour_cost_pct?: number | null;
    pricing_target_markup_ratio?: number | null;
  } = {};
  if ("pour_cost_pct" in parsed.data) {
    update.pricing_target_pour_cost_pct = parsed.data.pour_cost_pct ?? null;
  }
  if ("markup_ratio" in parsed.data) {
    update.pricing_target_markup_ratio = parsed.data.markup_ratio ?? null;
  }

  // Tenant-scope check (defense-in-depth alongside RLS).
  const { error: updateErr, data } = await supabase
    .from("wines")
    .update(update)
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .select(
      "id, pricing_target_pour_cost_pct, pricing_target_markup_ratio",
    )
    .maybeSingle();

  if (updateErr) {
    Sentry.captureException(updateErr, {
      tags: { surface: "wines-pricing-targets", phase: "update" },
      extra: { wineId: id, restaurantId },
    });
    return Errors.internal("Update failed.");
  }
  if (!data) {
    return Errors.notFound("Wine");
  }

  return NextResponse.json({
    wineId: data.id,
    pour_cost_pct: data.pricing_target_pour_cost_pct,
    markup_ratio: data.pricing_target_markup_ratio,
  });
}
