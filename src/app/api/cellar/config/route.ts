import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { Errors } from "@/lib/api/errors";
import { requireMembership } from "@/lib/api/auth";

export const runtime = "nodejs";

const CellarConfigSchema = z.object({
  rows: z.number().int().min(1).max(26).optional(),
  columns: z.number().int().min(1).max(30).optional(),
  name: z.string().min(1).optional(),
});

const SectionSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(100),
});

const PatchSectionsSchema = z.object({
  sections: z.array(SectionSchema),
  // BND-062 — explicit section_order for querying order without
  // deserializing the full sections array.
  section_order: z.array(z.string()).optional(),
});

export async function GET() {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  const { data: config } = await supabase
    .from("cellar_config")
    .select("*")
    .eq("restaurant_id", restaurantId)
    .limit(1)
    .single();

  return NextResponse.json(config ?? null);
}

export async function POST(request: NextRequest) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Errors.badRequest("Invalid JSON.");
  }

  const parsed = CellarConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return Errors.badRequest(parsed.error.issues[0]?.message ?? "Invalid input.");
  }

  const body = parsed.data;
  const rows = Math.max(1, Math.min(body.rows ?? 10, 26));
  const columns = Math.max(1, Math.min(body.columns ?? 10, 30));

  const { data: config, error } = await supabase
    .from("cellar_config")
    .insert({
      restaurant_id: restaurantId,
      name: body.name ?? "Main Cellar",
      rows,
      columns,
    })
    .select("*")
    .single();

  if (error) {
    console.error("cellar_config insert failed:", error);
    Sentry.captureException(error, {
      tags: { surface: "cellar-config", phase: "insert" },
      extra: { restaurantId, rows, columns },
    });
    return Errors.internal("Failed to create cellar configuration.");
  }

  return NextResponse.json(config);
}

/**
 * PATCH /api/cellar/config
 *
 * BND-060 + BND-062. Updates the sections array and section_order stored
 * in cellar_config.labels. Sections define named groupings for organizing
 * the cellar (e.g., "Reds by Region", "Cult Cabs").
 *
 * BND-062 adds section_order — an array of section IDs that mirrors the
 * display order. Consumers can read section_order directly instead of
 * extracting ids from the sections array.
 *
 * Body: { sections: Array<{ id: string, name: string }>, section_order?: string[] }
 */
export async function PATCH(request: NextRequest) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Errors.badRequest("Invalid JSON.");
  }

  const parsed = PatchSectionsSchema.safeParse(raw);
  if (!parsed.success) {
    return Errors.validation(parsed.error.issues, "Invalid sections.");
  }

  const { sections, section_order } = parsed.data;

  // Fetch existing config to read the current labels.
  const { data: existing } = await supabase
    .from("cellar_config")
    .select("id, labels")
    .eq("restaurant_id", restaurantId)
    .limit(1)
    .single();

  if (!existing) {
    // No config yet — create one with the sections.
    const { data: config, error } = await supabase
      .from("cellar_config")
      .insert({
        restaurant_id: restaurantId,
        name: "Main Cellar",
        rows: 10,
        columns: 10,
        labels: {
          sections,
          section_order: section_order ?? sections.map((s) => s.id),
        },
      })
      .select("*")
      .single();

    if (error) {
      console.error("cellar_config insert (sections) failed:", error);
      Sentry.captureException(error, {
        tags: { surface: "cellar-config", phase: "patch-insert" },
        extra: { restaurantId },
      });
      return Errors.internal("Failed to create cellar configuration.");
    }

    return NextResponse.json(config);
  }

  // BND-062 — merge sections AND section_order into existing labels.
  const currentLabels = (existing.labels as Record<string, unknown>) ?? {};
  const updatedLabels = {
    ...currentLabels,
    sections,
    section_order: section_order ?? sections.map((s) => s.id),
  };

  const { data: config, error } = await supabase
    .from("cellar_config")
    .update({ labels: updatedLabels })
    .eq("id", existing.id)
    .select("*")
    .single();

  if (error) {
    console.error("cellar_config patch failed:", error);
    Sentry.captureException(error, {
      tags: { surface: "cellar-config", phase: "patch-update" },
      extra: { restaurantId },
    });
    return Errors.internal("Failed to update cellar configuration.");
  }

  return NextResponse.json(config);
}
