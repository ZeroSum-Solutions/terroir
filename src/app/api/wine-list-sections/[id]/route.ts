import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { requireRole } from "@/lib/api/auth";
import { isOwnWineListSection } from "@/lib/api/wine-list-scope";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

const PatchSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
  })
  .strict();

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
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const parsed = PatchSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body.", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  if (!(await isOwnWineListSection(supabase, id, restaurantId))) {
    return NextResponse.json({ error: "Section not found." }, { status: 404 });
  }

  const { error } = await supabase
    .from("wine_list_sections")
    .update({ name: parsed.data.name })
    .eq("id", id);

  if (error) {
    console.error("wine_list_sections update failed:", error);
    Sentry.captureException(error, {
      tags: { surface: "wine-list-sections", phase: "update" },
      extra: { restaurantId, section_id: id },
    });
    return NextResponse.json({ error: "Update failed." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Params },
) {
  const { id } = await params;
  const auth = await requireRole(["owner", "manager"]);
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  if (!(await isOwnWineListSection(supabase, id, restaurantId))) {
    return NextResponse.json({ error: "Section not found." }, { status: 404 });
  }

  const { error } = await supabase
    .from("wine_list_sections")
    .delete()
    .eq("id", id);

  if (error) {
    console.error("wine_list_sections delete failed:", error);
    Sentry.captureException(error, {
      tags: { surface: "wine-list-sections", phase: "delete" },
      extra: { restaurantId, section_id: id },
    });
    return NextResponse.json({ error: "Delete failed." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
