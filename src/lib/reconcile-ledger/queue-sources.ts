import {
  buildDuplicateSources,
  buildReconcileQueue,
  parseBottleFormat,
  suggestWineMatch,
  wineMatchIdentityFromLine,
  type QueueSourceInput,
  type WineMatchCandidate,
} from "@/lib/reconcile-queue";
import type { LineageWine } from "@/lib/lineage/rollups";
import { findDuplicateSuspects } from "@/lib/lineage/rollups";
import type { Database, Json } from "@/types/database";
import { wineDisplayName } from "@/lib/wine-display-name";

type Inventory = Database["public"]["Tables"]["inventory_items"]["Row"];
type Scan = Database["public"]["Tables"]["invoice_scans"]["Row"];
type Wine = Database["public"]["Tables"]["wines"]["Row"];
type Line = Record<string, Json | undefined>;

function number(value: Json | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function text(value: Json | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stockByWine(inventory: Inventory[]) {
  const stock = new Map<string, { quantity: number; cost: number; addedAt: string }>();
  for (const item of inventory) {
    const current = stock.get(item.wine_id);
    const quantity = (current?.quantity ?? 0) + item.quantity;
    const newer = !current || item.added_at > current.addedAt;
    stock.set(item.wine_id, {
      quantity,
      cost: newer ? item.unit_cost : current.cost,
      addedAt: newer ? item.added_at : current.addedAt,
    });
  }
  return stock;
}

function lineageWines(wines: Wine[], inventory: Inventory[]): LineageWine[] {
  const stock = stockByWine(inventory);
  return wines.flatMap((wine) => {
    const value = stock.get(wine.id);
    if (!value || value.quantity <= 0) return [];
    return [{
      id: wine.id,
      lineageId: wine.lineage_id,
      producer: wine.producer,
      name: wine.name,
      vintage: wine.vintage,
      sizeMl: wine.size_ml,
      quantity: value.quantity,
      unitCost: value.cost,
      value: value.quantity * value.cost,
    }];
  });
}

function claimedDuplicateIds(sources: QueueSourceInput[]) {
  return new Set(sources.flatMap((source) => {
    const ids = source.metadata?.wineIds;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  }));
}

function duplicateCosts(lineage: LineageWine[], inventory: Inventory[]) {
  const costs: Record<string, number> = {};
  for (const suspect of findDuplicateSuspects(lineage)) {
    const subject = `${suspect.lineageId}:${suspect.vintage ?? "NV"}:${suspect.sizeMl}`;
    const latest = inventory.filter((item) => suspect.wineIds.includes(item.wine_id))
      .sort((left, right) => right.added_at.localeCompare(left.added_at))[0];
    costs[subject] = latest?.unit_cost ?? 0;
  }
  return costs;
}

function withDuplicateLinks(sources: QueueSourceInput[]) {
  return sources.map((source) => {
    const ids = source.metadata?.wineIds;
    const representative = Array.isArray(ids) && typeof ids[0] === "string" ? ids[0] : null;
    const { action: _action, ...reviewOnly } = source;
    return representative
      ? { ...reviewOnly, deepLink: `/cellar?wine=${encodeURIComponent(representative)}` }
      : reviewOnly;
  });
}

function ambiguousSources(lineage: LineageWine[], claimed: Set<string>) {
  return lineage.filter((wine) => wine.lineageId == null && !claimed.has(wine.id))
    .map<QueueSourceInput>((wine) => ({
      subjectTable: "wines",
      subjectId: wine.id,
      title: `${wine.producer} ${wineDisplayName(wine.producer, wine.name)} ${wine.vintage ?? "NV"}`,
      detail: "Stocked wine has no confirmed lineage",
      units: wine.quantity,
      unitCost: wine.unitCost ?? 0,
      wineId: wine.id,
      deepLink: `/cellar?wine=${encodeURIComponent(wine.id)}`,
    }));
}

function unplacedSources(
  inventory: Inventory[],
  wines: Map<string, Wine>,
  claimed: Set<string>,
) {
  return inventory.filter((item) => item.bin_id == null && !claimed.has(item.wine_id))
    .map<QueueSourceInput>((item) => {
      const wine = wines.get(item.wine_id);
      return {
        subjectTable: "inventory_items",
        subjectId: item.id,
        title: wine
          ? `${wine.producer} ${wineDisplayName(wine.producer, wine.name)}`
          : "Unplaced inventory",
        detail: "Inventory has no bin",
        units: item.quantity,
        unitCost: item.unit_cost,
        wineId: item.wine_id,
        deepLink: `/cellar?wine=${encodeURIComponent(item.wine_id)}`,
        action: { type: "place_bin", label: "Place in bin", targetId: item.id },
      };
    });
}

function candidates(wines: Wine[]): WineMatchCandidate[] {
  return wines.map((wine) => ({
    wineId: wine.id,
    title: `${wine.producer} ${wineDisplayName(wine.producer, wine.name)} ${wine.vintage ?? "NV"}`,
    lwin: wine.lwin_id,
    producer: wine.producer,
    cuvee: wine.name,
    vintage: wine.vintage,
    format: wine.size_ml,
    deepLink: `/cellar?wine=${encodeURIComponent(wine.id)}`,
  }));
}

function exactInventoryMatch(line: Line, item: Inventory, wine: Wine) {
  const format = line.format == null ? null : parseBottleFormat(line.format as string | number);
  const inventoryFormat = item.format ? parseBottleFormat(item.format) : wine.size_ml;
  return text(line.producer)?.toLocaleLowerCase("en-US") === wine.producer.trim().toLocaleLowerCase("en-US")
    && text(line.name ?? line.cuvee)?.toLocaleLowerCase("en-US") === wine.name.trim().toLocaleLowerCase("en-US")
    && (line.vintage === null || typeof line.vintage === "number" ? line.vintage : undefined) === wine.vintage
    && number(line.qty ?? line.quantity) === item.quantity
    && number(line.unitCost ?? line.unit_cost) === item.unit_cost
    && format !== null && format === inventoryFormat && format === wine.size_ml;
}

function unmatchedSource(scan: Scan, line: Line, index: number, wineCandidates: WineMatchCandidate[]) {
  const suffix = text(line.id) ?? String(index);
  const identity = wineMatchIdentityFromLine(line);
  const name = identity.cuvee ?? "Unknown wine";
  const producer = identity.producer ?? "Unknown producer";
  const units = number(line.qty ?? line.quantity);
  const suggestion = suggestWineMatch(identity, wineCandidates) ?? undefined;
  return {
    subjectTable: "invoice_scans",
    subjectId: `${scan.id}:${index}:${suffix}`,
    title: `${producer} ${name}`,
    detail: `Unmatched line from ${scan.distributor_name}`,
    units,
    unitCost: number(line.unitCost ?? line.unit_cost),
    // An unmatched line is unmatched: most of the time there is NO wine in this
    // cellar to open, and pointing at one would be inventing a destination. So
    // the link goes to the suggested wine only when identity resolution found
    // one — that candidate already carries a deepLink (`candidates()` above),
    // which was computed, copied into the suggestion by `toSuggestion`, and
    // then never rendered — and otherwise to the scan the line came from,
    // which is where the line can actually be matched or committed.
    deepLink: suggestion?.deepLink ?? `/scan/${encodeURIComponent(scan.id)}`,
    suggestion,
    action: suggestion ? {
      type: "match_scan" as const,
      label: "Match wine",
      targetId: scan.id,
      payload: { line_index: index, wine_id: suggestion.wineId, expected_line: line },
    } : undefined,
  } satisfies QueueSourceInput;
}

function unmatchedScans(scans: Scan[], inventory: Inventory[], wines: Wine[]) {
  const wineMap = new Map(wines.map((wine) => [wine.id, wine]));
  const available = inventory.filter((item) => item.invoice_scan_id != null)
    .sort((left, right) => left.id.localeCompare(right.id));
  const used = new Set<string>();
  const sources: QueueSourceInput[] = [];
  for (const scan of scans) {
    const lines = Array.isArray(scan.final_line_items) ? scan.final_line_items : [];
    lines.forEach((raw, index) => {
      if (!raw || Array.isArray(raw) || typeof raw !== "object") return;
      const line = raw as Line;
      const explicit = text(line.wine_id);
      if (explicit && wineMap.has(explicit)) return;
      const match = available.find((item) => item.invoice_scan_id === scan.id
        && !used.has(item.id) && !!wineMap.get(item.wine_id)
        && exactInventoryMatch(line, item, wineMap.get(item.wine_id)!));
      if (match) used.add(match.id);
      else sources.push(unmatchedSource(scan, line, index, candidates(wines)));
    });
  }
  return sources;
}

export function assembleQueue(inventory: Inventory[], scans: Scan[], wines: Wine[]) {
  const lineage = lineageWines(wines, inventory);
  const duplicateSuspects = withDuplicateLinks(buildDuplicateSources(lineage, {
    latestUnitCostBySubject: duplicateCosts(lineage, inventory),
  }));
  const duplicateIds = claimedDuplicateIds(duplicateSuspects);
  const ambiguousLineages = ambiguousSources(lineage, duplicateIds);
  const claimed = new Set([...duplicateIds, ...ambiguousLineages.map((row) => row.subjectId)]);
  return buildReconcileQueue({
    duplicateSuspects,
    ambiguousLineages,
    unmatchedScans: unmatchedScans(scans, inventory, wines),
    unplaced: unplacedSources(inventory, new Map(wines.map((wine) => [wine.id, wine])), claimed),
  });
}
