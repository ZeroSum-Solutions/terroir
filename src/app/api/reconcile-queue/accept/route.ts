import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/api/auth";
import { apiError, Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseJson } from "@/lib/api/validation";
import { acceptBatch, LedgerFailure, type LedgerAction } from "@/lib/reconcile-ledger";

export const runtime = "nodejs";

const Id = z.string().uuid();
const AcceptSchema = z.array(z.discriminatedUnion("action_type", [
  z.strictObject({
    action_type: z.literal("place_bin"),
    subject_table: z.literal("inventory_items"),
    subject_id: Id,
    patch: z.strictObject({ bin_id: Id }),
  }),
  z.strictObject({
    action_type: z.literal("match_scan"),
    subject_table: z.literal("invoice_scans"),
    subject_id: Id,
    patch: z.strictObject({
      line_index: z.number().int().min(0).max(499),
      wine_id: Id,
      expected_line: z.record(z.string(), z.unknown()),
    }),
  }),
  z.strictObject({
    action_type: z.literal("link_lineage"),
    subject_table: z.literal("wines"),
    subject_id: Id,
    patch: z.strictObject({ lineage_id: Id }),
  }),
  z.strictObject({
    action_type: z.literal("dismiss"),
    subject_table: z.enum(["inventory_items", "invoice_scans", "wines"]),
    subject_id: Id,
    patch: z.strictObject({}),
  }),
])).min(1).max(100).superRefine((items, context) => {
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    const suffix = item.action_type === "match_scan" ? `:${item.patch.line_index}` : "";
    const key = `${item.subject_table}:${item.subject_id}${suffix}`;
    if (seen.has(key)) context.addIssue({
      code: "custom",
      message: "Each subject may appear only once per batch.",
      path: [index, "subject_id"],
    });
    seen.add(key);
  }
});

function failure(error: LedgerFailure) {
  if (error.kind === "not_found") return Errors.notFound("Reconcile subject");
  if (error.kind === "identity_mismatch") {
    return apiError(422, "identity_mismatch", error.message, error.details);
  }
  if (error.kind === "conflict") {
    return apiError(409, "reconcile_conflict", error.message, error.details);
  }
  return apiError(500, "internal_error", "Reconciliation failed.", error.details);
}

export async function POST(request: NextRequest) {
  return withApiHandler(async () => {
    const auth = await requireRole(["owner", "manager"]);
    if (auth instanceof NextResponse) return auth;
    const parsed = await parseJson(request, AcceptSchema);
    if (!parsed.ok) return parsed.response;
    try {
      const result = await acceptBatch(
        auth.supabase, auth.restaurantId, auth.user.id,
        parsed.data as LedgerAction[],
      );
      return NextResponse.json(result, { status: 201 });
    } catch (error) {
      if (error instanceof LedgerFailure) return failure(error);
      throw error;
    }
  });
}
