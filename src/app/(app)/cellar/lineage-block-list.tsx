import { useMemo, useState, useCallback } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CellarWineRow } from "./types";
import { wineDisplayName } from "@/lib/wine-display-name";

/**
 * OPP-1 (wave 0, EV-1.1) — lineage grouping. Wines sharing a lineage
 * (one producer-cuvée) render as a single expandable block: a header row
 * with the rollup (vintage span, total bottles) above per-vintage child
 * rows. Wines whose lineage has a single member — or none — render as
 * plain rows in their original position, so cellars without vintage
 * siblings look exactly as before.
 */
export type LineageBlock =
  | { kind: "single"; row: CellarWineRow }
  | {
      kind: "lineage";
      lineageId: string;
      producer: string;
      name: string;
      totalBottles: number;
      span: [number, number] | null;
      rows: CellarWineRow[];
    };

export function buildLineageBlocks(
  wines: CellarWineRow[],
  preserveOrder: boolean,
): LineageBlock[] {
  const counts = new Map<string, number>();
  for (const w of wines) {
    if (w.lineage_id) counts.set(w.lineage_id, (counts.get(w.lineage_id) ?? 0) + 1);
  }
  const emitted = new Set<string>();
  const blocks: LineageBlock[] = [];
  for (const w of wines) {
    const lid = w.lineage_id;
    if (!lid || (counts.get(lid) ?? 0) < 2) {
      blocks.push({ kind: "single", row: w });
      continue;
    }
    if (emitted.has(lid)) continue;
    emitted.add(lid);
    // With an explicit sort active, siblings keep the incoming (already
    // sorted) order — re-sorting newest-first here silently contradicted
    // the chosen sort inside expanded blocks (Sol audit, 2026-08-27).
    // Newest-first stays the default when no sort is chosen.
    const filtered = wines.filter((x) => x.lineage_id === lid);
    const members = preserveOrder
      ? filtered
      : filtered.sort((a, b) => (b.vintage ?? -1) - (a.vintage ?? -1));
    const vints = members
      .map((m) => m.vintage)
      .filter((v): v is number => v != null);
    blocks.push({
      kind: "lineage",
      lineageId: lid,
      producer: members[0].producer,
      name: members[0].name,
      totalBottles: members.reduce((acc, m) => acc + m.sealed_count, 0),
      span: vints.length ? [Math.min(...vints), Math.max(...vints)] : null,
      rows: members,
    });
  }
  return blocks;
}

export function LineageBlockList({
  wines,
  renderRow,
  preserveOrder = false,
}: {
  wines: CellarWineRow[];
  renderRow: (row: CellarWineRow) => React.ReactNode;
  // True when a URL sort is active: lineage siblings then keep the
  // sorted order instead of the newest-first default.
  preserveOrder?: boolean;
}) {
  const blocks = useMemo(
    () => buildLineageBlocks(wines, preserveOrder),
    [wines, preserveOrder],
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () =>
      new Set(
        blocks.flatMap((block) =>
          block.kind === "lineage" ? [block.lineageId] : [],
        ),
      ),
  );

  const toggle = useCallback((lineageId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(lineageId)) next.delete(lineageId);
      else next.add(lineageId);
      return next;
    });
  }, []);

  return (
    <>
      {blocks.map((block) =>
        block.kind === "single" ? (
          <div key={block.row.wine_id}>{renderRow(block.row)}</div>
        ) : (
          <div key={`lineage-${block.lineageId}`} data-lineage-id={block.lineageId}>
            <button
              type="button"
              data-lineage-header
              onClick={() => toggle(block.lineageId)}
              aria-expanded={!collapsed.has(block.lineageId)}
              className="flex w-full items-center gap-sm px-md py-sm text-left bg-surface-sunken hover:bg-rule-strong/60 transition-colors"
            >
              <ChevronDown
                className={cn(
                  "h-4 w-4 shrink-0 text-grey transition-transform",
                  collapsed.has(block.lineageId) && "-rotate-90",
                )}
                strokeWidth={2}
                aria-hidden
              />
              <span className="min-w-0 flex-1">
                <span className="block text-[10.5px] font-medium uppercase tracking-[0.18em] text-ink-soft">
                  {block.producer}
                </span>
                <span className="block truncate font-serif text-[17px] font-medium text-ink">
                  {wineDisplayName(block.producer, block.name)}
                </span>
              </span>
              <span
                data-lineage-rollup
                className="tabular inline-flex shrink-0 items-center rounded-pill bg-surface/70 px-sm py-2xs text-[11px] font-medium text-ink-soft"
              >
                {block.rows.length} wines
                {block.span ? ` · ${block.span[0]}–${block.span[1]}` : ""}
                {` · ${block.totalBottles} btls`}
              </span>
            </button>
            {!collapsed.has(block.lineageId) && (
              <div
                data-lineage-children
                className="ml-md border-l-2 border-rule-strong divide-y divide-rule"
              >
                {block.rows.map((row) => (
                  <div key={row.wine_id}>{renderRow(row)}</div>
                ))}
              </div>
            )}
          </div>
        ),
      )}
    </>
  );
}
