// P1 slice 1 — the unified tier-1 merge (program plan D4, §7 P1).
//
// One ranked list over the tenant's cellar, the LWIN catalogue and the
// X-Wines corpus, under the interim two-corpus contract: HONEST dedupe only.
// Two rows merge on an identity key and nothing else —
//
//   - an ACCEPTED lwin_xwines_links row (P0's linkage) merges an LWIN row
//     with its X-Wines row into one catalogue result;
//   - a cellar row's own canonical identity (lwin7 / xwines_wine_id, expanded
//     through the accepted links) folds the catalogue rows it already owns
//     into the cellar row, which leads.
//
// Name similarity NEVER merges anything: presenting two maybe-same rows as
// one is exactly the false-merge class WS-IDENT abstains from, and a review
// or abstained link is not an identity. Rows nothing links render separately
// and carry deduped=false so the UI cannot claim otherwise.
//
// Ranking: score descending; a cellar row beats a catalogue row at equal
// score (owned beats discoverable, D4); remaining ties break on source then
// id so a re-render or a resumed request orders identically.

export type CellarHit = {
  id: string;
  name: string;
  producer: string;
  vintage: number | null;
  region: string | null;
  country: string | null;
  varietal: string | null;
  colour: string | null;
  heroImageUrl: string | null;
  isEightysixed: boolean;
  /** Bottles on hand; null when the inventory read degraded (unknown ≠ zero). */
  quantity: number | null;
  /** Most recently stocked bin; null when unknown or unbinned. */
  bin: string | null;
  /** From the wine's canonical_wines row, when resolved. */
  lwin7: string | null;
  xwinesWineId: number | null;
  score: number;
};

export type LwinHit = {
  lwinId: string;
  displayName: string;
  producer: string | null;
  region: string | null;
  country: string | null;
  colour: string | null;
  type: string | null;
  score: number;
};

export type XwinesHit = {
  wineId: number;
  name: string;
  wineryName: string | null;
  regionName: string | null;
  country: string | null;
  type: string | null;
  imageUrl: string | null;
  score: number;
};

export type UnifiedResult = {
  kind: "cellar" | "catalogue";
  /** Which corpora stand behind this row — the provenance badge (D4). */
  provenance: "cellar" | "lwin" | "xwines" | "lwin+xwines";
  /** True ONLY when an identity key actually merged two surfaced rows. */
  deduped: boolean;
  /** Placeholder-identity cellar row (D4/A6) — never canonical, never linked. */
  provisional: boolean;
  score: number;
  name: string;
  producer: string | null;
  vintage: number | null;
  region: string | null;
  country: string | null;
  colour: string | null;
  imageUrl: string | null;
  isEightysixed: boolean | null;
  /** Availability is a tenant fact: null on catalogue rows and degraded reads. */
  quantity: number | null;
  bin: string | null;
  wineId: string | null;
  lwinId: string | null;
  xwinesWineId: number | null;
};

export type MergeInput = {
  cellar: readonly CellarHit[];
  lwin: readonly LwinHit[];
  xwines: readonly XwinesHit[];
  /** lwin_id → xwines_wine_id, ACCEPTED lwin_xwines_links rows only. */
  acceptedLinks: ReadonlyMap<string, number>;
  limit: number;
};

function isProvisionalProducer(producer: string): boolean {
  const trimmed = producer.trim();
  return trimmed === "" || trimmed.toLowerCase() === "unknown";
}

/** score desc → cellar first → lwin before xwines → id, for a total order. */
function compareResults(a: UnifiedResult, b: UnifiedResult): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.kind !== b.kind) return a.kind === "cellar" ? -1 : 1;
  if (a.provenance !== b.provenance) return a.provenance < b.provenance ? -1 : 1;
  const aKey = a.wineId ?? a.lwinId ?? String(a.xwinesWineId);
  const bKey = b.wineId ?? b.lwinId ?? String(b.xwinesWineId);
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
}

export function mergeUnifiedResults(input: MergeInput): UnifiedResult[] {
  const { cellar, lwin, xwines, acceptedLinks, limit } = input;

  const lwinByXwines = new Map<number, string>();
  for (const [lwinId, wineId] of acceptedLinks) lwinByXwines.set(wineId, lwinId);

  // Catalogue side first: LWIN rows absorb their accepted-link X-Wines row.
  const unabsorbedXwines = new Map(xwines.map((x) => [x.wineId, x]));
  const catalogue: UnifiedResult[] = [];
  for (const hit of lwin) {
    const linkedWineId = acceptedLinks.get(hit.lwinId) ?? null;
    const absorbed = linkedWineId !== null ? unabsorbedXwines.get(linkedWineId) : undefined;
    if (absorbed) unabsorbedXwines.delete(absorbed.wineId);
    catalogue.push({
      kind: "catalogue",
      provenance: linkedWineId !== null ? "lwin+xwines" : "lwin",
      // Deduped means two SURFACED rows became one — a link whose corpus row
      // did not match the query enriches, it does not merge.
      deduped: absorbed !== undefined,
      provisional: false,
      score: Math.max(hit.score, absorbed?.score ?? 0),
      name: hit.displayName,
      producer: hit.producer,
      vintage: null,
      region: hit.region,
      country: hit.country,
      colour: hit.colour,
      imageUrl: absorbed?.imageUrl ?? null,
      isEightysixed: null,
      quantity: null,
      bin: null,
      wineId: null,
      lwinId: hit.lwinId,
      xwinesWineId: linkedWineId,
    });
  }
  for (const hit of unabsorbedXwines.values()) {
    const linkedLwinId = lwinByXwines.get(hit.wineId) ?? null;
    catalogue.push({
      kind: "catalogue",
      provenance: linkedLwinId !== null ? "lwin+xwines" : "xwines",
      deduped: false,
      provisional: false,
      score: hit.score,
      name: hit.name,
      producer: hit.wineryName,
      vintage: null,
      region: hit.regionName,
      country: hit.country,
      colour: hit.type,
      imageUrl: hit.imageUrl,
      isEightysixed: null,
      quantity: null,
      bin: null,
      wineId: null,
      lwinId: linkedLwinId,
      xwinesWineId: hit.wineId,
    });
  }

  // Cellar side: each row's identity keys, expanded through the links, fold
  // away the catalogue rows the tenant already owns.
  const results: UnifiedResult[] = [];
  for (const hit of cellar) {
    const lwinKeys = new Set<string>();
    const xwinesKeys = new Set<number>();
    if (hit.lwin7 !== null) {
      lwinKeys.add(hit.lwin7);
      const linked = acceptedLinks.get(hit.lwin7);
      if (linked !== undefined) xwinesKeys.add(linked);
    }
    if (hit.xwinesWineId !== null) {
      xwinesKeys.add(hit.xwinesWineId);
      const reverse = lwinByXwines.get(hit.xwinesWineId);
      if (reverse !== undefined) lwinKeys.add(reverse);
    }

    let folded = false;
    if (lwinKeys.size > 0 || xwinesKeys.size > 0) {
      for (let i = catalogue.length - 1; i >= 0; i--) {
        const row = catalogue[i];
        if (
          (row.lwinId !== null && lwinKeys.has(row.lwinId)) ||
          (row.xwinesWineId !== null && xwinesKeys.has(row.xwinesWineId))
        ) {
          catalogue.splice(i, 1);
          folded = true;
        }
      }
    }

    results.push({
      kind: "cellar",
      provenance: "cellar",
      deduped: folded,
      provisional: isProvisionalProducer(hit.producer),
      score: hit.score,
      name: hit.name,
      producer: hit.producer,
      vintage: hit.vintage,
      region: hit.region,
      country: hit.country,
      colour: hit.colour,
      imageUrl: hit.heroImageUrl,
      isEightysixed: hit.isEightysixed,
      quantity: hit.quantity,
      bin: hit.bin,
      wineId: hit.id,
      lwinId: lwinKeys.size > 0 ? [...lwinKeys].sort()[0] : null,
      xwinesWineId: xwinesKeys.size > 0 ? [...xwinesKeys].sort((a, b) => a - b)[0] : null,
    });
  }

  results.push(...catalogue);
  return results.sort(compareResults).slice(0, limit);
}
