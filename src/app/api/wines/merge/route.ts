import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";

export const runtime = "nodejs";

/**
 * POST /api/wines/merge — collapse a true duplicate wine record (OPP-1,
 * EV-1.2/EV-1.3). Merging is only for same-lineage, same-vintage, same-format
 * pairs: for wine, vintage is identity, not duplication. The route pre-checks
 * the guards for friendly 422s; the merge_wines RPC re-enforces them
 * atomically and repoints every referrer before deleting the source, so the
 * combined quantity and full audit trail survive.
 */
const MergeSchema = z.object({
  source_id: z.string().uuid(),
  target_id: z.string().uuid(),
});

const GUARD_CODES =
  /^(cross_vintage_merge|format_mismatch_merge|lineage_mismatch_merge|identical_merge)/;

export async function POST(request: NextRequest) {
  const auth = await requireRole(["owner", "manager"]);
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Errors.invalidJson();
  }
  const parsed = MergeSchema.safeParse(raw);
  if (!parsed.success) {
    return Errors.validation(parsed.error.issues, "Invalid input.");
  }
  const { source_id, target_id } = parsed.data;
  if (source_id === target_id) {
    return Errors.badRequest("Source and target are the same wine.");
  }

  const { data: wines, error } = await supabase
    .from("wines")
    .select("id, lineage_id, vintage, size_ml, name, producer")
    .eq("restaurant_id", restaurantId)
    .in("id", [source_id, target_id]);

  if (error) {
    console.error("merge preflight failed:", error);
    Sentry.captureException(error, {
      tags: { surface: "cellar", phase: "merge-preflight" },
      extra: { restaurant_id: restaurantId },
    });
    return Errors.internal("Failed to load wines for merge.");
  }

  const source = wines?.find((w) => w.id === source_id);
  const target = wines?.find((w) => w.id === target_id);
  if (!source || !target) {
    return Errors.notFound("Wine");
  }

  if (
    source.lineage_id == null ||
    target.lineage_id == null ||
    source.lineage_id !== target.lineage_id
  ) {
    return Errors.unprocessable(
      "lineage_mismatch_merge",
      "These wines are not the same producer-cuvée. Merging is only for true duplicates.",
    );
  }
  if ((source.vintage ?? 0) !== (target.vintage ?? 0)) {
    return Errors.unprocessable(
      "cross_vintage_merge",
      `${source.vintage ?? "NV"} and ${target.vintage ?? "NV"} are distinct vintages of ${target.producer} ${target.name} — they are already linked as vintage siblings, not duplicates.`,
    );
  }
  if (source.size_ml !== target.size_ml) {
    return Errors.unprocessable(
      "format_mismatch_merge",
      `${source.size_ml} ml and ${target.size_ml} ml are distinct formats.`,
    );
  }

  const { data: moved, error: rpcError } = await supabase.rpc("merge_wines", {
    p_source_wine_id: source_id,
    p_target_wine_id: target_id,
  });

  if (rpcError) {
    // Defense in depth: the RPC re-checks the guards under lock; a race can
    // surface one here even after a clean preflight (verify finding V3:
    // concurrent A→B and B→A merges race the preflight).
    if (GUARD_CODES.test(rpcError.message)) {
      return Errors.unprocessable("merge_rejected", rpcError.message);
    }
    if (rpcError.message.startsWith("wine_not_found")) {
      return Errors.notFound("Wine");
    }
    if (rpcError.message.startsWith("forbidden")) {
      return Errors.forbidden(rpcError.message);
    }
    console.error("merge_wines rpc failed:", rpcError);
    Sentry.captureException(rpcError, {
      tags: { surface: "cellar", phase: "merge-rpc" },
      extra: { restaurant_id: restaurantId, source_id, target_id },
    });
    return Errors.internal("Merge failed.");
  }

  return NextResponse.json({ merged: true, target_id, moved });
}
