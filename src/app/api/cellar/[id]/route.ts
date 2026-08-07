import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireRole } from "@/lib/api/auth";
import { z } from "zod";
import { apiError, Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { idempotentMutationResponse } from "@/lib/api/idempotent-mutation";
import {
  createIdempotencyRequestHash,
  isValidIdempotencyKey,
} from "@/lib/api/idempotency";
import { apiResultResponse } from "@/lib/api/result-response";
import { parseJson, parseParams } from "@/lib/api/validation";
import type { Json } from "@/types/database";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

const ParamsSchema = z.strictObject({ id: z.string().uuid() });

const EditInventorySchema = z.object({
  quantity: z.number().int().min(0).optional(),
  unit_cost: z.number().min(0).optional(),
  bin_location: z.string().trim().max(50).nullable().optional(),
});

type EditInventoryMutationBody =
  | {
      id: string;
      quantity: number;
      unit_cost: number | null;
      bin_location: string | null;
    }
  | { error: { code: string; message: string } };

type CellarDeleteOutcome =
  | "deleted"
  | "not_found"
  | "wine_has_pours"
  | "wine_has_inventory"
  | "wine_on_lists"
  | "wine_from_scan"
  | "replay"
  | "idempotency_key_reused"
  | "idempotency_key_expired"
  | "idempotency_outcome_unknown"
  | "idempotency_in_progress";

type CellarDeleteResult = {
  outcome: CellarDeleteOutcome;
  response_status: number;
  response_body: Json;
  replayed: boolean;
};

const CELLAR_DELETE_OUTCOMES: readonly CellarDeleteOutcome[] = [
  "deleted",
  "not_found",
  "wine_has_pours",
  "wine_has_inventory",
  "wine_on_lists",
  "wine_from_scan",
  "replay",
  "idempotency_key_reused",
  "idempotency_key_expired",
  "idempotency_outcome_unknown",
  "idempotency_in_progress",
];

/**
 * PATCH /api/cellar/[id] — edit an inventory item.
 *
 * Role-gated to owner | manager. Staff receives 403.
 * Scoped by restaurant_id (defense-in-depth).
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
    const { id } = parsedParams.data;

    const parsed = await parseJson(request, EditInventorySchema);
    if (!parsed.ok) return parsed.response;
    const updates = parsed.data;
    if (Object.keys(updates).length === 0) {
      return Errors.badRequest("No valid fields to update.");
    }

    const hasIdempotencyKey =
      request.headers.get("Idempotency-Key") !== null;

    return idempotentMutationResponse<EditInventoryMutationBody>({
      request,
      supabase,
      restaurantId,
      operationId: "api:PATCH:/api/cellar/{param}",
      payload: { id, ...updates },
      releaseOnError: false,
      handler: async () => {
        // Defense-in-depth: scope by restaurant_id so a cross-tenant
        // inventory item id returns 404 instead of mutating another
        // restaurant's inventory.
        const { data, error } = await supabase
          .from("inventory_items")
          .update(updates)
          .eq("id", id)
          .eq("restaurant_id", restaurantId)
          .select("id, quantity, unit_cost, bin_location")
          .single();

        if (error && error.code !== "PGRST116") {
          console.error("inventory_items update failed:", error);
          Sentry.captureException(error, {
            tags: { surface: "cellar", phase: "edit-inventory" },
            extra: { restaurantId, inventory_item_id: id },
          });
          if (hasIdempotencyKey) throw error;
          return {
            status: 500,
            body: {
              error: {
                code: "internal_error",
                message: "Update failed.",
              },
            },
          };
        }

        if (!data) {
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

        return { status: 200, body: data };
      },
    });
  });
}

/**
 * DELETE /api/cellar/[id] — delete a wine from the cellar.
 *
 * Owner-only. Checks referential integrity before deleting:
 * the wine must have no pour_events, inventory_items, wine_list_items,
 * or invoice_scans referencing it. If any exist, returns 409 with
 * a descriptive message listing which references block deletion.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Params },
) {
  return withApiHandler(async () => {
    const auth = await requireRole(["owner"]);
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsedParams = await parseParams(params, ParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;
    const wineId = parsedParams.data.id.toLowerCase();
    const rawKey = request.headers.get("Idempotency-Key");
    if (rawKey !== null && !isValidIdempotencyKey(rawKey)) {
      return Errors.badRequest(
        "Invalid Idempotency-Key.",
        undefined,
        "invalid_idempotency_key",
      );
    }

    const { data, error } = await supabase.rpc(
      "delete_cellar_wine_idempotent",
      {
        p_restaurant_id: restaurantId,
        p_wine_id: wineId,
        ...(rawKey
          ? {
              p_idempotency_key: rawKey,
              p_request_hash: createIdempotencyRequestHash({ id: wineId }),
            }
          : {}),
      },
    );
    if (error) {
      if (error.code === "42501") return Errors.forbidden("Forbidden.");
      if (rawKey && error.code === "22023") {
        return Errors.badRequest(
          "Invalid cellar deletion request.",
          undefined,
          "invalid_cellar_deletion_request",
        );
      }
      captureCellarDeleteError(error, "rpc", restaurantId, wineId);
      return rawKey
        ? apiError(
            503,
            "idempotency_unavailable",
            "Request idempotency is temporarily unavailable.",
          )
        : Errors.internal();
    }

    const result = firstCellarDeleteResult(data);
    if (!isCellarDeleteResult(result, rawKey !== null)) {
      captureCellarDeleteError(
        new Error("delete_cellar_wine_idempotent returned an invalid result"),
        "result",
        restaurantId,
        wineId,
      );
      return rawKey
        ? apiError(
            503,
            "idempotency_unavailable",
            "Request idempotency is temporarily unavailable.",
          )
        : Errors.internal();
    }

    return apiResultResponse({
      status: result.response_status,
      body: result.response_body,
      ...(cellarDeleteHeaders(result, rawKey !== null)
        ? { headers: cellarDeleteHeaders(result, rawKey !== null)! }
        : {}),
    });
  });
}

function firstCellarDeleteResult(data: unknown): CellarDeleteResult | null {
  if (!Array.isArray(data) || data.length !== 1) return null;
  return data[0] as CellarDeleteResult | null;
}

function isCellarDeleteResult(
  row: CellarDeleteResult | null,
  isKeyed: boolean,
): row is CellarDeleteResult {
  if (
    !row ||
    !CELLAR_DELETE_OUTCOMES.includes(row.outcome) ||
    !Number.isInteger(row.response_status) ||
    typeof row.replayed !== "boolean" ||
    (row.outcome === "replay") !== row.replayed ||
    !isRecord(row.response_body) ||
    (!isKeyed && row.outcome === "replay") ||
    (!isKeyed && row.outcome.startsWith("idempotency_"))
  ) {
    return false;
  }
  if (row.outcome === "deleted") {
    return row.response_status === 200 && row.response_body.deleted === true;
  }
  const expected: Partial<Record<CellarDeleteOutcome, [number, string]>> = {
    not_found: [404, "not_found"],
    wine_has_pours: [409, "wine_has_pours"],
    wine_has_inventory: [409, "wine_has_inventory"],
    wine_on_lists: [409, "wine_on_lists"],
    wine_from_scan: [409, "wine_from_scan"],
    idempotency_key_reused: [409, "idempotency_key_reused"],
    idempotency_key_expired: [409, "idempotency_key_expired"],
    idempotency_outcome_unknown: [409, "idempotency_outcome_unknown"],
    idempotency_in_progress: [409, "idempotency_in_progress"],
  };
  if (row.outcome === "replay") {
    return (
      (row.response_status === 200 && row.response_body.deleted === true) ||
      (row.response_status === 404 &&
        isErrorBody(row.response_body as Record<string, unknown>, "not_found")) ||
      (row.response_status === 409 &&
        [
          "wine_has_pours",
          "wine_has_inventory",
          "wine_on_lists",
          "wine_from_scan",
        ].some((code) =>
          isErrorBody(row.response_body as Record<string, unknown>, code),
        ))
    );
  }
  const [status, code] = expected[row.outcome] ?? [];
  return (
    row.response_status === status &&
    isErrorBody(row.response_body as Record<string, unknown>, code ?? "")
  );
}

function cellarDeleteHeaders(
  row: CellarDeleteResult,
  isKeyed: boolean,
): Record<string, string> | null {
  if (row.outcome === "idempotency_in_progress") {
    return { "Retry-After": "1" };
  }
  if (!isKeyed) return null;
  if (row.outcome === "replay") return { "Idempotency-Replayed": "true" };
  if (
    [
      "deleted",
      "not_found",
      "wine_has_pours",
      "wine_has_inventory",
      "wine_on_lists",
      "wine_from_scan",
    ].includes(row.outcome)
  ) {
    return { "Idempotency-Replayed": "false" };
  }
  return null;
}

function isErrorBody(body: Record<string, unknown>, code: string): boolean {
  return (
    isRecord(body.error) &&
    body.error.code === code &&
    typeof body.error.message === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function captureCellarDeleteError(
  error: unknown,
  phase: string,
  restaurantId: string,
  wineId: string,
): void {
  try {
    Sentry.captureException(error, {
      tags: { surface: "cellar-delete-idempotency", phase },
      extra: { restaurantId, wineId },
    });
  } catch {
    // Observability must not replace the route's fail-closed result.
  }
}
