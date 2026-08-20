import {
  findDuplicateSuspects,
  type DuplicateSuspect,
  type LineageWine,
} from "../lineage/rollups";
import type { QueueSourceInput } from "./types";

export type DuplicateSourceOptions = {
  /** Latest added_at cost for the whole suspect group, resolved by the caller. */
  latestUnitCostBySubject: Readonly<Record<string, number | null | undefined>>;
};

function subjectId(suspect: DuplicateSuspect): string {
  return `${suspect.lineageId}:${suspect.vintage ?? "NV"}:${suspect.sizeMl}`;
}

function toSource(
  suspect: DuplicateSuspect,
  wines: readonly LineageWine[],
  unitCost: number,
): QueueSourceInput {
  const members = wines
    .filter((wine) => suspect.wineIds.includes(wine.id))
    .sort((left, right) => left.id.localeCompare(right.id));
  const representative = members[0];
  const vintage = suspect.vintage ?? "NV";
  return {
    subjectTable: "wine_lineages",
    subjectId: subjectId(suspect),
    title: `${representative.producer} ${representative.name} ${vintage}`,
    detail: `${members.length} records share lineage, vintage, and ${suspect.sizeMl}ml format`,
    units: members.reduce((sum, wine) => sum + wine.quantity, 0),
    unitCost,
    action: { type: "link_lineage", label: "Review duplicates" },
    metadata: { wineIds: members.map((wine) => wine.id) },
  };
}

export function buildDuplicateSources(
  wines: readonly LineageWine[],
  options: DuplicateSourceOptions,
): QueueSourceInput[] {
  return findDuplicateSuspects([...wines])
    .map((suspect) => {
      const latestCost = options.latestUnitCostBySubject[subjectId(suspect)] ?? 0;
      return toSource(suspect, wines, latestCost);
    })
    .sort((left, right) => left.subjectId.localeCompare(right.subjectId));
}
