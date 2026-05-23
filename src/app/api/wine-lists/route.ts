import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { requireRole } from "@/lib/api/auth";
import { DEFAULT_SECTIONS } from "@/lib/wine-list/types";
import { Errors } from "@/lib/api/errors";

export const runtime = "nodejs";

const CreateListSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

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

  const parsed = CreateListSchema.safeParse(raw);
  if (!parsed.success) {
    return Errors.badRequest(
        parsed.error.issues[0]?.message ?? "Invalid input.",
      );
  }

  const { name, description } = parsed.data;

  // Create the wine list
  const insertPayload: { name: string; restaurant_id: string; description?: string } = {
    name: name.trim(),
    restaurant_id: restaurantId,
  };
  if (description?.trim()) {
    insertPayload.description = description.trim();
  }

  const { data: list, error: listError } = await supabase
    .from("wine_lists")
    .insert(insertPayload)
    .select("id")
    .single();

  if (listError || !list) {
    console.error("wine_lists insert failed:", listError);
    Sentry.captureException(listError ?? new Error("list null without error"), {
      tags: { surface: "wine-lists", phase: "wine_lists-insert" },
      extra: { restaurantId },
    });
    return Errors.internal("Failed to create wine list.");
  }

  // Create default sections
  const sectionInserts = DEFAULT_SECTIONS.map((sectionName, idx) => ({
    wine_list_id: list.id,
    name: sectionName,
    position: idx,
  }));

  const { error: sectionsError } = await supabase
    .from("wine_list_sections")
    .insert(sectionInserts);

  if (sectionsError) {
    console.error("wine_list_sections insert failed:", sectionsError);
    Sentry.captureException(sectionsError, {
      tags: { surface: "wine-lists", phase: "wine_list_sections-insert" },
      extra: { restaurantId, wineListId: list.id, sectionCount: DEFAULT_SECTIONS.length },
    });
    // Clean up the list. BND-008: scope the cleanup by restaurant_id too —
    // if RLS is ever misconfigured on wine_lists this defense-in-depth filter
    // still prevents a cross-tenant delete.
    await supabase
      .from("wine_lists")
      .delete()
      .eq("id", list.id)
      .eq("restaurant_id", restaurantId);
    return Errors.internal("Failed to create sections.");
  }

  return NextResponse.json({ id: list.id });
}
