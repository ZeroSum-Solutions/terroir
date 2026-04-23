import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { requireMembership } from "@/lib/api/auth";

export const runtime = "nodejs";

const EntrySchema = z.object({
  wine_id: z.string().uuid(),
  new_remaining_ml: z.number().int().min(0).max(5000),
  note: z.string().trim().max(500).optional(),
});

const BodySchema = z.object({
  entries: z.array(EntrySchema).min(1).max(100),
});

/**
 * POST /api/reconcile
 *
 * BND-038. End-of-shift reconcile: batch-update open_bottles.remaining_ml
 * to match physical reality. Each entry inserts a `reconcile` pour_event
 * via reconcile_open_bottle RPC; the trigger then updates open_bottles.
 *
 * Role-gated inside the RPC to owner | manager.
 *
 * 200: { updated: N }
 * 400: invalid body / empty entries / > 100 entries
 * 401: unauthenticated (from requireMembership)
 * 403: role mismatch (reported by RPC as 42501)
 * 500: unhandled RPC failure (partial updated count returned)
 */
export async function POST(request: NextRequest) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase } = auth;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body.", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  let updated = 0;
  for (const entry of parsed.data.entries) {
    const { error } = await supabase.rpc("reconcile_open_bottle", {
      p_wine_id: entry.wine_id,
      p_new_remaining_ml: entry.new_remaining_ml,
      p_note: (entry.note ?? null) as unknown as string,
    });

    if (error) {
      if (error.code === "42501") {
        return NextResponse.json({ error: "Forbidden." }, { status: 403 });
      }
      console.error("reconcile_open_bottle failed:", error);
      Sentry.captureException(error, {
        tags: { surface: "reconcile", phase: "reconcile_open_bottle-rpc" },
        extra: { wine_id: entry.wine_id },
      });
      return NextResponse.json(
        { error: "Reconcile failed.", updated },
        { status: 500 },
      );
    }
    updated += 1;
  }

  revalidatePath("/availability");

  return NextResponse.json({ updated });
}
