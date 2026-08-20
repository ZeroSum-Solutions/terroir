import type {
  QueueSourceInput,
  ReconcileQueue,
  ReconcileQueueKind,
  ReconcileQueueRow,
  ReconcileQueueSources,
  ReconcileQueueSummary,
} from "./types";

function stableRowId(kind: ReconcileQueueKind, source: QueueSourceInput): string {
  return `reconcile:${kind}:${source.subjectTable}:${source.subjectId}`;
}

function toRow(kind: ReconcileQueueKind, source: QueueSourceInput): ReconcileQueueRow {
  return {
    ...source,
    id: stableRowId(kind, source),
    kind,
    atRisk: source.units * source.unitCost,
  };
}

export function rankQueueRows(rows: readonly ReconcileQueueRow[]): ReconcileQueueRow[] {
  return [...rows].sort((left, right) => {
    const byCapital = right.atRisk - left.atRisk;
    return byCapital === 0 ? left.id.localeCompare(right.id) : byCapital;
  });
}

function summarize(rows: readonly ReconcileQueueRow[]): ReconcileQueueSummary {
  return rows.reduce<ReconcileQueueSummary>(
    (summary, row) => ({
      itemCount: summary.itemCount + 1,
      unitCount: summary.unitCount + row.units,
      atRisk: summary.atRisk + row.atRisk,
    }),
    { itemCount: 0, unitCount: 0, atRisk: 0 },
  );
}

export function buildReconcileQueue(sources: ReconcileQueueSources): ReconcileQueue {
  const rows = rankQueueRows([
    ...sources.unplaced.map((source) => toRow("unplaced", source)),
    ...sources.unmatchedScans.map((source) => toRow("unmatched_scan", source)),
    ...sources.duplicateSuspects.map((source) => toRow("duplicate_suspect", source)),
    ...sources.ambiguousLineages.map((source) => toRow("ambiguous_lineage", source)),
  ]);
  return { rows, summary: summarize(rows) };
}
