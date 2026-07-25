import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { Errors } from "@/lib/api/errors";
import { requireCapability, requireMembership } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { idempotentMutationResponse } from "@/lib/api/idempotent-mutation";
import type { Json } from "@/types/database";

export const runtime = "nodejs";

const CellarConfigSchema = z.strictObject({
  rows: z.number().int().min(1).max(26).optional(),
  columns: z.number().int().min(1).max(30).optional(),
  name: z.string().trim().min(1).optional(),
});

const SectionSchema = z.strictObject({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1).max(100),
});
type Section = z.infer<typeof SectionSchema>;

const PourDefaultSchema = z.strictObject({
  size_ml: z.number().int().positive(),
  colour: z.string().trim().min(1).max(50),
  default_oz: z.number().positive(),
});
type PourDefault = z.infer<typeof PourDefaultSchema>;

const PatchSectionsSchema = z.strictObject({
  sections: z.array(SectionSchema).optional(),
  // BND-062 — explicit section_order for querying order without
  // deserializing the full sections array.
  section_order: z.array(z.string().trim().min(1)).optional(),
  pour_defaults: z.array(PourDefaultSchema).optional(),
});

type CellarConfigMutationBody =
  | Record<string, unknown>
  | { error: { code: string; message: string } };

class CellarConfigProviderError extends Error {
  constructor(
    readonly safeMessage: string,
    options: { cause: unknown },
  ) {
    super(safeMessage, options);
    this.name = "CellarConfigProviderError";
  }
}

export async function GET() {
  return withApiHandler(async () => {
    const auth = await requireMembership();
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const { data: config, error } = await supabase
      .from("cellar_config")
      .select("*")
      .eq("restaurant_id", restaurantId)
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error("cellar_config fetch failed:", error);
      Sentry.captureException(error, {
        tags: { surface: "cellar-config", phase: "fetch" },
        extra: { restaurantId },
      });
      return Errors.internal("Failed to fetch cellar configuration.");
    }

    return NextResponse.json(config);
  });
}

export async function POST(request: NextRequest) {
  return withApiHandler(() => createCellarConfig(request));
}

async function createCellarConfig(request: NextRequest) {
  const auth = await requireCapability("cellar:manage");
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
  const normalized = {
    name: body.name ?? "Main Cellar",
    rows: body.rows ?? 10,
    columns: body.columns ?? 10,
  };

  try {
    return await idempotentMutationResponse<CellarConfigMutationBody>({
      request,
      supabase,
      restaurantId,
      operationId: "api:POST:/api/cellar/config",
      payload: normalized,
      releaseOnError: false,
      handler: async () => {
        const { data: config, error } = await supabase
          .from("cellar_config")
          .insert({
            restaurant_id: restaurantId,
            ...normalized,
          })
          .select("*")
          .single();

        if (error) {
          console.error("cellar_config insert failed:", error);
          Sentry.captureException(error, {
            tags: { surface: "cellar-config", phase: "insert" },
            extra: {
              restaurantId,
              rows: normalized.rows,
              columns: normalized.columns,
            },
          });
          throw new CellarConfigProviderError(
            "Failed to create cellar configuration.",
            { cause: error },
          );
        }

        return { status: 200, body: config };
      },
    });
  } catch (error) {
    if (error instanceof CellarConfigProviderError) {
      return Errors.internal(error.safeMessage);
    }
    throw error;
  }
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
  return withApiHandler(() => updateCellarConfig(request));
}

async function updateCellarConfig(request: NextRequest) {
  const auth = await requireCapability("cellar:manage");
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

  const { sections, section_order, pour_defaults } = parsed.data;

  // If no data to update, return 400.
  if (section_order !== undefined && sections === undefined) {
    return Errors.badRequest('Provide sections with section_order.');
  }
  if (sections === undefined && pour_defaults === undefined) {
    return Errors.badRequest('Provide sections and/or pour_defaults.');
  }

  const normalized = { sections, section_order, pour_defaults };

  try {
    return await idempotentMutationResponse<CellarConfigMutationBody>({
      request,
      supabase,
      restaurantId,
      operationId: "api:PATCH:/api/cellar/config",
      payload: normalized,
      releaseOnError: false,
      handler: async () => {
        // Fetching and conditionally inserting/updating stay inside the
        // fail-closed boundary. A provider or completion ambiguity therefore
        // cannot replay either branch on a retry.
        const { data: existing, error: lookupError } = await supabase
          .from("cellar_config")
          .select("id, labels")
          .eq("restaurant_id", restaurantId)
          .limit(1)
          .single();

        if (lookupError && lookupError.code !== "PGRST116") {
          console.error("cellar_config patch lookup failed:", lookupError);
          Sentry.captureException(lookupError, {
            tags: {
              surface: "cellar-config",
              phase: "patch-fetch",
            },
            extra: { restaurantId },
          });
          throw new CellarConfigProviderError(
            "Failed to update cellar configuration.",
            { cause: lookupError },
          );
        }

        if (!existing) {
          const createLabels: {
            sections?: Section[];
            section_order?: string[];
            pour_defaults?: PourDefault[];
          } = {};
          if (sections !== undefined) {
            createLabels.sections = sections;
            createLabels.section_order =
              section_order ?? sections.map((section) => section.id);
          }
          if (pour_defaults !== undefined) {
            createLabels.pour_defaults = pour_defaults;
          }
          const { data: config, error } = await supabase
            .from("cellar_config")
            .insert({
              restaurant_id: restaurantId,
              name: "Main Cellar",
              rows: 10,
              columns: 10,
              labels: createLabels as Json,
            })
            .select("*")
            .single();

          if (error) {
            console.error("cellar_config insert (sections) failed:", error);
            Sentry.captureException(error, {
              tags: {
                surface: "cellar-config",
                phase: "patch-insert",
              },
              extra: { restaurantId },
            });
            throw new CellarConfigProviderError(
              "Failed to create cellar configuration.",
              { cause: error },
            );
          }

          return { status: 200, body: config };
        }

        // BND-062 / BND-125 — merge sections, section_order, and
        // pour_defaults into existing labels.
        const currentLabels =
          (existing.labels as Record<string, unknown>) ?? {};
        const updatedLabels: Record<string, unknown> = {
          ...currentLabels,
        };
        if (sections !== undefined) {
          updatedLabels.sections = sections;
          updatedLabels.section_order =
            section_order ?? sections.map((section) => section.id);
        }
        if (pour_defaults !== undefined) {
          updatedLabels.pour_defaults = pour_defaults;
        }

        const { data: config, error } = await supabase
          .from("cellar_config")
          .update({ labels: updatedLabels as Json })
          .eq("id", existing.id)
          .select("*")
          .single();

        if (error) {
          console.error("cellar_config patch failed:", error);
          Sentry.captureException(error, {
            tags: {
              surface: "cellar-config",
              phase: "patch-update",
            },
            extra: { restaurantId },
          });
          throw new CellarConfigProviderError(
            "Failed to update cellar configuration.",
            { cause: error },
          );
        }

        return { status: 200, body: config };
      },
    });
  } catch (error) {
    if (error instanceof CellarConfigProviderError) {
      return Errors.internal(error.safeMessage);
    }
    throw error;
  }
}
