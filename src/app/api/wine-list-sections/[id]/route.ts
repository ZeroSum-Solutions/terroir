import { NextResponse, type NextRequest } from "next/server";
import { requireRole } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { idempotentMutationResponse } from "@/lib/api/idempotent-mutation";
import { parseJson, parseParams } from "@/lib/api/validation";
import {
  RenameWineListSectionBodySchema,
  WineListSectionIdParamsSchema,
} from "@/lib/api/wine-list-section-schemas";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;
type SectionMutationResponse =
  | { ok: true }
  | {
      error: {
        code: "not_found";
        message: string;
      };
    };
type SectionScope = {
  id: string;
  wine_list_id: string;
  wine_lists: { restaurant_id: string } | Array<{ restaurant_id: string }>;
};

function belongsToRestaurant(
  section: SectionScope,
  restaurantId: string,
): boolean {
  const parent = Array.isArray(section.wine_lists)
    ? section.wine_lists[0]
    : section.wine_lists;
  return parent?.restaurant_id === restaurantId;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Params },
) {
  return withApiHandler(async () => {
    const auth = await requireRole(["owner", "manager"]);
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsedParams = await parseParams(
      params,
      WineListSectionIdParamsSchema,
    );
    if (!parsedParams.ok) return parsedParams.response;
    const parsedBody = await parseJson(
      request,
      RenameWineListSectionBodySchema,
      { message: "Invalid body." },
    );
    if (!parsedBody.ok) return parsedBody.response;

    const { id } = parsedParams.data;
    const body = parsedBody.data;

    return idempotentMutationResponse<SectionMutationResponse>({
      request,
      supabase,
      restaurantId,
      operationId: "api:PATCH:/api/wine-list-sections/{param}",
      payload: { id, body },
      releaseOnError: false,
      handler: async () => {
        const { data, error: lookupError } = await supabase
          .from("wine_list_sections")
          .select("id, wine_list_id, wine_lists!inner(restaurant_id)")
          .eq("id", id)
          .maybeSingle();
        if (lookupError) throw lookupError;
        const target = data as unknown as SectionScope | null;
        if (!target || !belongsToRestaurant(target, restaurantId)) {
          return {
            status: 404,
            body: {
              error: {
                code: "not_found" as const,
                message: "Section not found.",
              },
            },
          };
        }

        const { data: updated, error } = await supabase
          .from("wine_list_sections")
          .update({ name: body.name })
          .eq("id", id)
          .eq("wine_list_id", target.wine_list_id)
          .select("id")
          .maybeSingle();
        if (error) throw error;
        if (!updated) {
          return {
            status: 404,
            body: {
              error: {
                code: "not_found" as const,
                message: "Section not found.",
              },
            },
          };
        }

        return { status: 200, body: { ok: true as const } };
      },
    });
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Params },
) {
  return withApiHandler(async () => {
    const auth = await requireRole(["owner", "manager"]);
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsedParams = await parseParams(
      params,
      WineListSectionIdParamsSchema,
    );
    if (!parsedParams.ok) return parsedParams.response;
    const { id } = parsedParams.data;

    return idempotentMutationResponse<SectionMutationResponse>({
      request,
      supabase,
      restaurantId,
      operationId: "api:DELETE:/api/wine-list-sections/{param}",
      payload: { id },
      releaseOnError: false,
      handler: async () => {
        const { data, error: lookupError } = await supabase
          .from("wine_list_sections")
          .select("id, wine_list_id, wine_lists!inner(restaurant_id)")
          .eq("id", id)
          .maybeSingle();
        if (lookupError) throw lookupError;
        const target = data as unknown as SectionScope | null;
        if (!target || !belongsToRestaurant(target, restaurantId)) {
          return {
            status: 404,
            body: {
              error: {
                code: "not_found" as const,
                message: "Section not found.",
              },
            },
          };
        }

        const { data: removed, error } = await supabase
          .from("wine_list_sections")
          .delete()
          .eq("id", id)
          .eq("wine_list_id", target.wine_list_id)
          .select("id")
          .maybeSingle();
        if (error) throw error;
        if (!removed) {
          return {
            status: 404,
            body: {
              error: {
                code: "not_found" as const,
                message: "Section not found.",
              },
            },
          };
        }

        return { status: 200, body: { ok: true as const } };
      },
    });
  });
}
