import { NextResponse, type NextRequest } from "next/server";
import { requireRole } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { idempotentMutationResponse } from "@/lib/api/idempotent-mutation";
import { parseJson } from "@/lib/api/validation";
import { ReorderWineListSectionsBodySchema } from "@/lib/api/wine-list-section-schemas";

export const runtime = "nodejs";

type ReorderSectionsResponse =
  | { ok: true }
  | {
      error: {
        code:
          | "not_found"
          | "bad_request"
          | "forbidden"
          | "section_order_conflict";
        message: string;
      };
    };

type SectionScope = {
  id: string;
  wine_list_id: string;
  wine_lists: { restaurant_id: string } | Array<{ restaurant_id: string }>;
};

function restaurantIdFor(section: SectionScope): string | undefined {
  const parent = Array.isArray(section.wine_lists)
    ? section.wine_lists[0]
    : section.wine_lists;
  return parent?.restaurant_id;
}

export async function PATCH(request: NextRequest) {
  return withApiHandler(async () => {
    const auth = await requireRole(["owner", "manager"]);
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsed = await parseJson(request, ReorderWineListSectionsBodySchema);
    if (!parsed.ok) return parsed.response;
    const { orderedIds } = parsed.data;

    return idempotentMutationResponse<ReorderSectionsResponse>({
      request,
      supabase,
      restaurantId,
      operationId: "api:PATCH:/api/wine-list-sections/reorder",
      payload: { orderedIds },
      releaseOnError: false,
      handler: async () => {
        const { data, error: lookupError } = await supabase
          .from("wine_list_sections")
          .select("id, wine_list_id, wine_lists!inner(restaurant_id)")
          .in("id", orderedIds);
        if (lookupError) throw lookupError;
        const sections = (data ?? []) as unknown as SectionScope[];
        if (
          sections.length !== orderedIds.length ||
          sections.some(
            (section) => restaurantIdFor(section) !== restaurantId,
          )
        ) {
          return {
            status: 404,
            body: {
              error: {
                code: "not_found" as const,
                message: "One or more sections not found.",
              },
            },
          };
        }

        const wineListId = sections[0].wine_list_id;
        if (
          sections.some((section) => section.wine_list_id !== wineListId)
        ) {
          return {
            status: 400,
            body: {
              error: {
                code: "bad_request" as const,
                message: "All sections must belong to the same wine list.",
              },
            },
          };
        }

        const { error } = await supabase.rpc(
          "reorder_wine_list_sections",
          { p_ordered_ids: orderedIds },
        );
        if (error) {
          if (error.code === "T2101") {
            return {
              status: 400,
              body: {
                error: {
                  code: "bad_request",
                  message: "Invalid section order.",
                },
              },
            };
          }
          if (error.code === "T2102") {
            return {
              status: 404,
              body: {
                error: {
                  code: "not_found",
                  message: "One or more sections not found.",
                },
              },
            };
          }
          if (error.code === "T2104") {
            return {
              status: 403,
              body: {
                error: {
                  code: "forbidden",
                  message: "Forbidden.",
                },
              },
            };
          }
          if (error.code === "T2103") {
            return {
              status: 409,
              body: {
                error: {
                  code: "section_order_conflict",
                  message:
                    "Section order changed concurrently. Refresh and try again.",
                },
              },
            };
          }
          throw error;
        }

        return { status: 200, body: { ok: true as const } };
      },
    });
  });
}
