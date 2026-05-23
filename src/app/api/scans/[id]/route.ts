import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getAuthContext } from "@/lib/auth-context";
import { Errors } from "@/lib/api/errors";
import type { Json } from "@/types/database";

export const runtime = "nodejs";

const LineItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  producer: z.string(),
  vintage: z.number().nullable(),
  varietal: z.string(),
  region: z.string(),
  qty: z.number().int().min(1),
  unitCost: z.number().min(0),
  currency: z.string().nullable(),
  format: z.string().nullable(),
  confidence: z.number(),
});

const PatchSchema = z.object({
  items: z.array(LineItemSchema).min(1),
  edits: z.record(z.string(), z.boolean()),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { supabase, restaurantId } = auth;

  const { data: scan, error: fetchErr } = await supabase
    .from("invoice_scans")
    .select("id, restaurant_id")
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .single();

  if (fetchErr || !scan) {
    return NextResponse.json({ error: "Scan not found." }, { status: 404 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Errors.badRequest("Invalid JSON.");
  }

  const parsed = PatchSchema.safeParse(raw);
  if (!parsed.success) {
    return Errors.validation(parsed.error.issues, "Invalid input.");
  }

  const { items, edits } = parsed.data;

  const { error: updateErr } = await supabase
    .from("invoice_scans")
    .update({
      final_line_items: JSON.parse(JSON.stringify(items)) as Json,
      edits: JSON.parse(JSON.stringify(edits)) as Json,
    })
    .eq("id", id);

  if (updateErr) {
    console.error("Failed to update scan line items:", updateErr);
    return Errors.internal("Failed to save edits.");
  }

  return NextResponse.json({ success: true, itemCount: items.length });
}
