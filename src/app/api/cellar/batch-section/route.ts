import { NextResponse, type NextRequest } from "next/server";
import { requireRole } from "@/lib/api/auth";
import { BatchCellarSectionBodySchema } from "@/lib/api/cellar-collection-schemas";
import { withApiHandler } from "@/lib/api/handler";
import { idempotentMutationResponse } from "@/lib/api/idempotent-mutation";
import { parseJson } from "@/lib/api/validation";

export const runtime = "nodejs";

type BatchSectionMutationBody =
  | { updated: number; section: string }
  | { error: { code: string; message: string } };

/**
 * POST /api/cellar/batch-section — bulk-assign wines to a cellar section.
 *
 * Role-gated to owner | manager. Updates all inventory_items for the
 * given wines within the caller's restaurant in a single operation.
 * BND-064 — bulk-assign wines to a section.
 */
export async function POST(request: NextRequest) {
  return withApiHandler(async () => {
    const auth = await requireRole(["owner", "manager"]);
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsed = await parseJson(
      request,
      BatchCellarSectionBodySchema,
    );
    if (!parsed.ok) return parsed.response;
    const { wine_ids, section } = parsed.data;

    return idempotentMutationResponse<BatchSectionMutationBody>({
      request,
      supabase,
      restaurantId,
      operationId: "api:POST:/api/cellar/batch-section",
      payload: { wine_ids, section },
      releaseOnError: false,
      handler: async () => {
        const { error } = await supabase.rpc(
          "assign_cellar_section_batch",
          {
            p_restaurant_id: restaurantId,
            p_wine_ids: wine_ids,
            p_section: section,
          },
        );
        if (error) {
          if (error.message === "cellar_section_not_configured") {
            return {
              status: 400,
              body: {
                error: {
                  code: "bad_request",
                  message:
                    "Section is not configured for your restaurant.",
                },
              },
            };
          }
          if (error.message === "cellar_inventory_missing") {
            return {
              status: 404,
              body: {
                error: {
                  code: "not_found",
                  message: "Inventory item not found.",
                },
              },
            };
          }
          if (
            error.message === "cellar_batch_invalid_size" ||
            error.message === "cellar_batch_duplicate_wine"
          ) {
            return {
              status: 400,
              body: {
                error: {
                  code: "bad_request",
                  message: "Invalid cellar batch.",
                },
              },
            };
          }
          throw error;
        }

        return {
          status: 200,
          body: {
            updated: wine_ids.length,
            section,
          },
        };
      },
    });
  });
}
