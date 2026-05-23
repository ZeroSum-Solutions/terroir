import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireRole } from "@/lib/api/auth";
import { z } from "zod";
import { Errors } from "@/lib/api/errors";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

const EditWineSchema = z.object({
  producer: z.string().trim().min(1).max(255).optional(),
  name: z.string().trim().min(1).max(255).optional(),
  vintage: z
    .number()
    .int()
    .min(1900)
    .max(2100)
    .nullable()
    .optional(),
  varietal: z.string().trim().max(255).nullable().optional(),
  region: z.string().trim().max(255).nullable().optional(),
  tasting_notes: z.string().trim().max(5000).nullable().optional(),
});

/**
 * PATCH /api/wines/[id] — edit wine metadata.
 *
 * BND-055 + BND-056. Role-gated to owner | manager. Staff receives 403.
 * Scoped by restaurant_id for defense-in-depth.
 * Preserves enrichment_metadata (does not overwrite).
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Params },
) {
  const { id } = await params;
  const auth = await requireRole(["owner", "manager"]);
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Errors.badRequest("Invalid JSON.");
  }

  const parsed = EditWineSchema.safeParse(raw);
  if (!parsed.success) {
    return Errors.validation(parsed.error.issues, "Invalid input.");
  }

  const updates = parsed.data;
  if (Object.keys(updates).length === 0) {
    return Errors.badRequest("No valid fields to update.");
  }

  // Defense-in-depth: scope by restaurant_id.
  const { data, error } = await supabase
    .from("wines")
    .update(updates)
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .select(
      "id, producer, name, vintage, varietal, region, tasting_notes, updated_at",
    )
    .single();

  if (error) {
    console.error("wines update failed:", error);
    Sentry.captureException(error, {
      tags: { surface: "wines", phase: "edit-metadata" },
      extra: { restaurantId, wine_id: id },
    });
    return Errors.internal("Update failed.");
  }

  if (!data) {
    return Errors.notFound("Wine");
  }

  return NextResponse.json(data);
}
