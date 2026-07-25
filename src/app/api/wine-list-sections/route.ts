import { NextResponse, type NextRequest } from "next/server";
import { requireRole } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { idempotentMutationResponse } from "@/lib/api/idempotent-mutation";
import { parseJson } from "@/lib/api/validation";
import { CreateWineListSectionBodySchema } from "@/lib/api/wine-list-section-schemas";

export const runtime = "nodejs";

type CreateSectionResponse =
  | {
      id: string;
      wine_list_id: string;
      name: string;
      position: number;
      created_at: string;
    }
  | {
      error: {
        code: "not_found" | "forbidden";
        message: string;
      };
    };

/**
 * BND-025 / DEBT-005 — wire 'Add section' button in the wine-list editor.
 *
 * POST /api/wine-list-sections creates a new section at the end of the
 * given list. Defense-in-depth: we verify the wine_list_id belongs to a
 * list owned by the caller's restaurant before inserting, so a leaked id
 * from another tenant 404s instead of silently inserting.
 */

export async function POST(request: NextRequest) {
  return withApiHandler(async () => {
    const auth = await requireRole(["owner", "manager"]);
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsed = await parseJson(request, CreateWineListSectionBodySchema, {
      message: "Invalid body.",
    });
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    return idempotentMutationResponse<CreateSectionResponse>({
      request,
      supabase,
      restaurantId,
      operationId: "api:POST:/api/wine-list-sections",
      payload: body,
      releaseOnError: false,
      handler: async () => {
        const { wine_list_id, name } = body;
        const { data, error } = await supabase.rpc(
          "create_wine_list_section",
          {
            p_restaurant_id: restaurantId,
            p_wine_list_id: wine_list_id,
            p_name: name,
          },
        );
        if (error) {
          if (error.code === "T2105") {
            return {
              status: 404,
              body: {
                error: {
                  code: "not_found" as const,
                  message: "Wine list not found.",
                },
              },
            };
          }
          if (error.code === "T2106") {
            return {
              status: 403,
              body: {
                error: {
                  code: "forbidden" as const,
                  message: "Forbidden.",
                },
              },
            };
          }
          throw error;
        }
        const inserted = Array.isArray(data) ? data[0] : data;
        if (!inserted) {
          throw new Error("wine-list section insert returned no row");
        }

        return { status: 201, body: inserted };
      },
    });
  });
}
