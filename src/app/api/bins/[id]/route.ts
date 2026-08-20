import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireRole } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseJson, parseParams } from "@/lib/api/validation";
import type { Database } from "@/types/database";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

const ParamsSchema = z.strictObject({ id: z.string().uuid() });
const PatchSchema = z.strictObject({
  code: z.string().trim().min(1).max(50).optional(),
  zone: z.string().trim().max(100).nullable().optional(),
  capacity: z.number().int().positive().nullable().optional(),
  priority: z.number().int().optional(),
  retired_at: z.string().datetime({ offset: true }).nullable().optional(),
});
const BIN_FIELDS =
  "id, code, zone, capacity, priority, sort_order, retired_at";
type PatchUpdates = z.output<typeof PatchSchema>;
type BinSnapshot = Pick<
  Database["public"]["Tables"]["bins"]["Row"],
  "code" | "zone" | "capacity" | "priority" | "retired_at"
>;
type FailurePhase = "read-code" | "update" | "mirror-code" | "rollback-code";

const SAFE_FAILURE_MESSAGES: Record<FailurePhase, string> = {
  "read-code": "Bin code lookup failed.",
  update: "Bin update failed.",
  "mirror-code": "Bin code mirror failed.",
  "rollback-code": "Bin code rollback failed.",
};

function reportFailure(
  phase: FailurePhase,
  restaurantId: string,
  binId: string,
) {
  const safeError = new Error(SAFE_FAILURE_MESSAGES[phase]);
  console.error(safeError.message);
  Sentry.captureException(safeError, {
    tags: { surface: "bins", phase },
    extra: { restaurantId, binId },
  });
}

function currentBin(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
  binId: string,
) {
  return supabase
    .from("bins")
    .select("code, zone, capacity, priority, retired_at")
    .eq("id", binId)
    .eq("restaurant_id", restaurantId)
    .maybeSingle();
}

function updateBin(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
  binId: string,
  updates: PatchUpdates,
  expectedCode?: string,
) {
  const scoped = supabase
    .from("bins")
    .update(updates)
    .eq("id", binId)
    .eq("restaurant_id", restaurantId);
  return (expectedCode === undefined
    ? scoped
    : scoped.eq("code", expectedCode)
  ).select(BIN_FIELDS).maybeSingle();
}

function mirrorCode(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
  binId: string,
  code: string,
) {
  return supabase
    .from("inventory_items")
    .update({ bin_location: code })
    .eq("bin_id", binId)
    .eq("restaurant_id", restaurantId);
}

function rollbackBin(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
  binId: string,
  newCode: string,
  previous: PatchUpdates,
  attempted: PatchUpdates,
) {
  let scoped = supabase
    .from("bins")
    .update(previous)
    .eq("id", binId)
    .eq("restaurant_id", restaurantId)
    .eq("code", newCode);
  if (attempted.zone !== undefined) {
    scoped = attempted.zone === null
      ? scoped.is("zone", null)
      : scoped.eq("zone", attempted.zone);
  }
  if (attempted.capacity !== undefined) {
    scoped = attempted.capacity === null
      ? scoped.is("capacity", null)
      : scoped.eq("capacity", attempted.capacity);
  }
  if (attempted.priority !== undefined) {
    scoped = scoped.eq("priority", attempted.priority);
  }
  if (attempted.retired_at !== undefined) {
    scoped = attempted.retired_at === null
      ? scoped.is("retired_at", null)
      : scoped.eq("retired_at", attempted.retired_at);
  }
  return scoped.select("id").maybeSingle();
}

function rollbackValues(current: BinSnapshot, updates: PatchUpdates) {
  const previous: PatchUpdates = { code: current.code };
  if (updates.zone !== undefined) previous.zone = current.zone;
  if (updates.capacity !== undefined) previous.capacity = current.capacity;
  if (updates.priority !== undefined) previous.priority = current.priority;
  if (updates.retired_at !== undefined) previous.retired_at = current.retired_at;
  return previous;
}

function updateErrorResponse(
  error: { code?: string } | null,
  restaurantId: string,
  binId: string,
) {
  if (error?.code === "23505") {
    return Errors.conflict(
      "duplicate_bin_code",
      "A bin with that code already exists.",
    );
  }
  if (!error) return null;
  reportFailure("update", restaurantId, binId);
  return Errors.internal("Failed to update bin.");
}

async function renameBin(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
  binId: string,
  updates: PatchUpdates & { code: string },
) {
  const { data: current, error: readError } = await currentBin(
    supabase, restaurantId, binId,
  );
  if (readError) {
    reportFailure("read-code", restaurantId, binId);
    return Errors.internal("Failed to read bin.");
  }
  if (!current) return Errors.notFound("Bin");

  const { data, error } = await updateBin(
    supabase, restaurantId, binId, updates, current.code,
  );
  const errorResponse = updateErrorResponse(error, restaurantId, binId);
  if (errorResponse) return errorResponse;
  if (!data) return Errors.conflict("bin_changed", "Bin changed; retry.");

  const { error: mirrorError } = await mirrorCode(
    supabase, restaurantId, binId, updates.code,
  );
  if (!mirrorError) return NextResponse.json(data);
  reportFailure("mirror-code", restaurantId, binId);

  const { data: rollbackData, error: rollbackError } = await rollbackBin(
    supabase,
    restaurantId,
    binId,
    updates.code,
    rollbackValues(current, updates),
    updates,
  );
  if (rollbackError || !rollbackData) {
    reportFailure("rollback-code", restaurantId, binId);
  }
  return Errors.internal("Failed to mirror bin code.");
}

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
    const { id: binId } = parsedParams.data;

    const parsed = await parseJson(request, PatchSchema);
    if (!parsed.ok) return parsed.response;
    if (Object.keys(parsed.data).length === 0) {
      return Errors.badRequest("No valid fields to update.");
    }

    const updates = parsed.data;
    if (updates.code !== undefined) {
      return renameBin(supabase, restaurantId, binId, {
        ...updates,
        code: updates.code,
      });
    }
    const { data, error } = await updateBin(
      supabase,
      restaurantId,
      binId,
      updates,
    );

    const errorResponse = updateErrorResponse(error, restaurantId, binId);
    if (errorResponse) return errorResponse;
    if (!data) return Errors.notFound("Bin");
    return NextResponse.json(data);
  });
}
