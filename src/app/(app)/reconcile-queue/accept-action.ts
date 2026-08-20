import type { ReconcileQueueRow } from "@/lib/reconcile-queue";
import type { AcceptAction } from "./types";

function targetId(row: ReconcileQueueRow): string {
  return row.action?.targetId ?? row.subjectId;
}

export function buildAcceptAction(
  row: ReconcileQueueRow,
  binId?: string,
): AcceptAction | null {
  const action = row.action;
  if (!action) return null;
  if (action.type === "place_bin" && binId) {
    return {
      action_type: "place_bin",
      subject_table: "inventory_items",
      subject_id: targetId(row),
      patch: { bin_id: binId },
    };
  }
  const payload = action.payload;
  if (action.type === "match_scan"
    && typeof payload?.line_index === "number"
    && typeof payload.wine_id === "string"
    && isRecord(payload.expected_line)) {
    return {
      action_type: "match_scan",
      subject_table: "invoice_scans",
      subject_id: targetId(row),
      patch: {
        line_index: payload.line_index,
        wine_id: payload.wine_id,
        expected_line: payload.expected_line,
      },
    };
  }
  if (action.type === "link_lineage" && typeof payload?.lineage_id === "string") {
    return {
      action_type: "link_lineage",
      subject_table: "wines",
      subject_id: targetId(row),
      patch: { lineage_id: payload.lineage_id },
    };
  }
  if (action.type === "dismiss" && isDismissTable(row.subjectTable)) {
    return {
      action_type: "dismiss",
      subject_table: row.subjectTable,
      subject_id: targetId(row),
      patch: {},
    };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isDismissTable(
  value: string,
): value is "inventory_items" | "invoice_scans" | "wines" {
  return value === "inventory_items" || value === "invoice_scans" || value === "wines";
}
