import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { requireMembership } from "@/lib/api/auth";
import { isOwnWineListItem } from "@/lib/api/wine-list-scope";
import { Errors } from "@/lib/api/errors";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Params },
) {
  const { id } = await params;
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  // ARCH-014: verify the item's owning wine_list belongs to the
  // caller's restaurant before mutating. RLS still gates at the DB
  // level; this is application-layer defense-in-depth.
  if (!(await isOwnWineListItem(supabase, id, restaurantId))) {
    return Errors.notFound("Item");
  }

  const { error } = await supabase
    .from("wine_list_items")
    .delete()
    .eq("id", id);

  if (error) {
    console.error("wine_list_items delete failed:", error);
    Sentry.captureException(error, {
      tags: { surface: "wine-list-items", phase: "delete" },
      extra: { restaurantId, item_id: id },
    });
    return Errors.internal("Delete failed.");
  }

  return NextResponse.json({ ok: true });
}

// ARCH-017 / DEBT-011: `is_available` is NOT in the schema. The
// column is deprecated by BND-037's wines.is_eightysixed availability
// system; leaving the PATCH surface writable encouraged two parallel
// availability models to live on. Z.strict() below rejects any body
// that tries to write it (400). The column remains in the DB for
// read compatibility; dropping it is a separate migration-cleanup
// pass.
//
// BND-038 added glass_pour_ml + pour_size_mode.
// BND-170 added blurb, BND-171 added hidden.
const PatchSchema = z
  .object({
    glass_price: z.number().nullable().optional(),
    bottle_price: z.number().nullable().optional(),
    tasting_note: z.string().optional(),
    position: z.number().int().optional(),
    glass_pour_ml: z.number().int().positive().max(2000).nullable().optional(),
    pour_size_mode: z.enum(["fixed", "picker"]).optional(),
    name_override: z.string().nullable().optional(),
    blurb: z.string().nullable().optional(),
    hidden: z.boolean().optional(),
  })
  .strict();

export async function PATCH(
  request: NextRequest,
  { params }: { params: Params },
) {
  const { id } = await params;
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  let raw: unknown;
  try {
    raw = await request.json();
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

  // ARCH-014: verify ownership before update.
  if (!(await isOwnWineListItem(supabase, id, restaurantId))) {
    return Errors.notFound("Item");
  }

  const { error } = await supabase
    .from("wine_list_items")
    .update(parsed.data as any)
    .eq("id", id);

  if (error) {
    console.error("wine_list_items update failed:", error);
    Sentry.captureException(error, {
      tags: { surface: "wine-list-items", phase: "update" },
      extra: { restaurantId, item_id: id },
    });
    return Errors.internal("Update failed.");
  }

  return NextResponse.json({ ok: true });
}
