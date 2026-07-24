import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireRole } from "@/lib/api/auth";
import { z } from "zod";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { idempotentMutationResponse } from "@/lib/api/idempotent-mutation";
import { parseJson, parseParams } from "@/lib/api/validation";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

const ParamsSchema = z.strictObject({ id: z.string().uuid() });

const SectionSchema = z.object({
  section: z.string().trim().min(1).max(100).nullable(),
});

type SectionMutationBody =
  | { wine_id: string; section: string | null }
  | { error: { code: string; message: string } };

class CellarSectionProviderError extends Error {
  constructor(
    readonly safeMessage: string,
    options: { cause: unknown },
  ) {
    super(safeMessage, options);
    this.name = "CellarSectionProviderError";
  }
}

/**
 * PATCH /api/cellar/[id]/section — reassign a wine to a different cellar section.
 *
 * Role-gated to owner | manager. Updates all inventory_items for the
 * wine within the caller's restaurant.
 * BND-063 — drag-and-drop wine between sections.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Params },
) {
  return withApiHandler(async () => {
    const auth = await requireRole(["owner", "manager"]);
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsedParams = await parseParams(params, ParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;
    const { id: wineId } = parsedParams.data;

    const parsed = await parseJson(request, SectionSchema);
    if (!parsed.ok) return parsed.response;
    const { section } = parsed.data;

    try {
      return await idempotentMutationResponse<SectionMutationBody>({
        request,
        supabase,
        restaurantId,
        operationId: "api:PATCH:/api/cellar/{param}/section",
        payload: { id: wineId, section },
        releaseOnError: false,
        handler: async () => {
          // Keep the lookup, update, and deterministic result inside the
          // idempotency boundary so successful and not-found outcomes replay
          // without repeating provider work.
          const { data: wine, error: wineError } = await supabase
            .from("wines")
            .select("id")
            .eq("id", wineId)
            .eq("restaurant_id", restaurantId)
            .single();

          if (wineError && wineError.code !== "PGRST116") {
            Sentry.captureException(wineError, {
              tags: {
                surface: "cellar",
                phase: "find-wine-for-section",
              },
              extra: { restaurantId, wineId, section },
            });
            throw new CellarSectionProviderError(
              "Failed to find wine.",
              { cause: wineError },
            );
          }

          if (!wine) {
            return {
              status: 404,
              body: {
                error: {
                  code: "not_found",
                  message: "Wine not found.",
                },
              },
            };
          }

          const { data: updatedRows, error } = await supabase
            .from("inventory_items")
            .update({ section })
            .eq("wine_id", wineId)
            .eq("restaurant_id", restaurantId)
            .select("id");

          if (error) {
            Sentry.captureException(error, {
              tags: { surface: "cellar", phase: "update-section" },
              extra: { restaurantId, wineId, section },
            });
            throw new CellarSectionProviderError(
              "Failed to update section.",
              { cause: error },
            );
          }

          if (!updatedRows?.length) {
            return {
              status: 404,
              body: {
                error: {
                  code: "not_found",
                  message: "Inventory not found.",
                },
              },
            };
          }

          return {
            status: 200,
            body: { wine_id: wineId, section },
          };
        },
      });
    } catch (error) {
      // Keyed failures reach this catch only after withIdempotency marks the
      // owned claim outcome unknown. Keyless calls keep their exact historical
      // public envelope without leaking provider details.
      if (error instanceof CellarSectionProviderError) {
        return Errors.internal(error.safeMessage);
      }
      throw error;
    }
  });
}
