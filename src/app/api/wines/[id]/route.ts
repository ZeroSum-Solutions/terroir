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
  // BND-277 — manual drink-window override (#72)
  drink_window_start: z
    .number()
    .int()
    .min(1900)
    .max(2100)
    .nullable()
    .optional(),
  drink_window_end: z
    .number()
    .int()
    .min(1900)
    .max(2100)
    .nullable()
    .optional(),
  peak_year: z
    .number()
    .int()
    .min(1900)
    .max(2100)
    .nullable()
    .optional(),
});

/**
 * PATCH /api/wines/[id] — edit wine metadata.
 *
 * BND-055 + BND-056 + BND-277 + BND-278. Role-gated to owner | manager.
 * Staff receives 403.
 * Scoped by restaurant_id for defense-in-depth.
 * Preserves enrichment_metadata (does not overwrite).
 * Tracks manually-set enrichable fields in manual_overrides (#72, #78).
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

  // BND-277 / BND-278 — track which enrichable fields were manually set (#72, #78).
  const enrichableFieldMap: Record<string, string> = {
    region: "region",
    varietal: "varietal",
    country: "country",
    drink_window_start: "drink_window",
    drink_window_end: "drink_window",
    peak_year: "drink_window",
  };

  const overriddenFields = new Set<string>();
  for (const key of Object.keys(updates)) {
    const mapped = enrichableFieldMap[key];
    if (mapped) overriddenFields.add(mapped);
  }

  // Defense-in-depth: scope by restaurant_id.
  const { data, error } = await supabase
    .from("wines")
    .update(updates)
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .select(
      "id, producer, name, vintage, varietal, region, tasting_notes, drink_window_start, drink_window_end, peak_year, updated_at",
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

  // BND-277 / BND-278 — merge manual_overrides for any enrichable fields
  // that were manually set, so future enrichment skips them.
  if (overriddenFields.size > 0) {
    const { error: overrideError } = await supabase.rpc(
      "add_manual_overrides",
      {
        p_wine_id: id,
        p_fields: [...overriddenFields],
      },
    );
    if (overrideError) {
      console.error("add_manual_overrides failed:", overrideError);
      Sentry.captureException(overrideError, {
        tags: { surface: "wines", phase: "add_manual_overrides" },
        extra: { restaurantId, wine_id: id, fields: [...overriddenFields] },
      });
      // Non-fatal — the data update succeeded; overrides are best-effort.
    }
  }

  return NextResponse.json(data);
}
