import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireMembership } from "@/lib/api/auth";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Params },
) {
  const { id } = await params;
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase } = auth;

  const { error } = await supabase
    .from("wine_list_items")
    .delete()
    .eq("id", id);

  if (error) {
    console.error("wine_list_items delete failed:", error);
    return NextResponse.json({ error: "Delete failed." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

// BND-038: added glass_pour_ml + pour_size_mode to the allowed fields.
const PatchSchema = z
  .object({
    glass_price: z.number().nullable().optional(),
    bottle_price: z.number().nullable().optional(),
    tasting_note: z.string().optional(),
    is_available: z.boolean().optional(),
    position: z.number().int().optional(),
    glass_pour_ml: z.number().int().positive().max(2000).nullable().optional(),
    pour_size_mode: z.enum(["fixed", "picker"]).optional(),
  })
  .strict();

export async function PATCH(
  request: NextRequest,
  { params }: { params: Params },
) {
  const { id } = await params;
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase } = auth;

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

  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ error: "No valid fields." }, { status: 400 });
  }

  const { error } = await supabase
    .from("wine_list_items")
    .update(parsed.data)
    .eq("id", id);

  if (error) {
    console.error("wine_list_items update failed:", error);
    return NextResponse.json({ error: "Update failed." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
