// SCAN-03 / decision D1 — source presets for the CSV/XLSX importer.
//
// D1's call: v1 is EXPORT-FILE INGESTION, not credentialed API pulls
// (partner credentials are a procurement blocker, not a code one). A preset
// is a column-mapping profile over the pipeline that already exists; it does
// not fork the pipeline, and there is no OAuth connector anywhere here.
//
// TWO RULES GOVERN EVERY MAPPING IN THIS FILE.
//
// 1. PRESETS ARE ADDITIVE, NEVER OVERRIDING. `mapHeader` (row-validator.ts)
//    consults HEADER_SYNONYMS FIRST and only falls through to a preset for a
//    column the synonym table does not already recognise. So the worst a
//    wrong preset can do is map a column that would otherwise have been
//    IGNORED. It can never take a column the generic path already got right
//    and point it somewhere else. This is deliberate: a preset that silently
//    mismaps a cost or a quantity column is worse than no preset at all.
//
// 2. NOTHING HERE IS INVENTED. Each preset declares how well its columns are
//    actually known, and a preset with no verified schema carries NO columns
//    and NO detection signature — so it can never fire, and cannot mismap
//    anything. Filling one in later is a data change to this file, not an
//    architecture change, which is exactly the "reversal cost: low" D1
//    promised.
//
// WHAT WAS ACTUALLY VERIFIED (2026-08-30, web research):
//
//   * CellarTracker — DOCUMENTED. Its export dialog and column list are
//     public (support.cellartracker.com/article/29-exporting-data, plus a
//     third-party enumeration of the 59-column export). Notably, the
//     importer's existing HEADER_SYNONYMS table ALREADY covers most of it
//     (Producer, Wine, Vintage, Varietal, Region, Country, Size, Quantity,
//     Price, Currency, Location, Bin), so this preset is deliberately thin —
//     it fills four real gaps and no more.
//   * Vivino — NOT VERIFIABLE, and worse than that: Vivino has no official
//     structured CSV cellar export. What circulates are third-party
//     exporter scripts whose column names differ from each other. There is
//     no single schema to encode.
//   * BinWise, BevSpot, Bevrly — NOT VERIFIABLE. None publishes an export
//     schema. ("Bevrly" is the field-walk vendor: Devin was heard saying
//     "Beverly", and this repo's own docs/evals/README.md calls Terroir a
//     "Bevrly-response build", which makes Bevrly — a real restaurant
//     beverage-inventory scanner app — a far better fit than the decision
//     record's original low-confidence BevSpot guess. BevSpot is kept
//     alongside it because it is also a real product in this category.)
//
// The `generic` profile below is the one that does the real work for an
// unrecognised export. Its column names are NOT any vendor's schema — they
// are the column labels that recur across beverage-inventory and cellar
// exports generally, each one included only because it is unambiguous.

import type { CanonicalHeader } from "./constants";

export const SOURCE_PRESET_IDS = [
  "generic",
  "cellartracker",
  "vivino",
  "binwise",
  "bevspot",
  "bevrly",
] as const;

export type SourcePresetId = (typeof SOURCE_PRESET_IDS)[number];

export type PresetConfidence =
  /** Columns taken from the vendor's own published export documentation. */
  | "documented"
  /** Column labels that recur across the category, not a vendor schema. */
  | "conventional"
  /** No schema could be verified; declared so it can be filled in later. */
  | "unverified";

export type SourcePreset = {
  id: SourcePresetId;
  label: string;
  confidence: PresetConfidence;
  /** Why this preset knows what it knows — surfaced in the report, not the UI. */
  provenance: string;
  /** Lowercased, trimmed vendor header -> canonical field. Additive only. */
  columns: Readonly<Record<string, CanonicalHeader>>;
  /**
   * Lowercased headers whose presence identifies this source. Empty means
   * "never auto-detects", which is the correct behaviour for a preset whose
   * schema is unknown.
   */
  signature: readonly string[];
};

/**
 * Column labels that recur across cellar and beverage-inventory exports.
 * Every entry is here because it has exactly one plausible meaning.
 *
 * DELIBERATELY ABSENT, for the same reason HEADER_SYNONYMS excludes them:
 * anything derived. "case cost", "extended cost", "total value", "valuation"
 * and "on-hand value" are all quantity-multiplied or market-valued figures;
 * importing one as `unit_cost` would silently multiply or replace every
 * bottle cost in the cellar.
 */
const GENERIC_COLUMNS: Record<string, CanonicalHeader> = {
  // Identity
  item: "name",
  "item name": "name",
  "item description": "name",
  product: "name",
  "product name": "name",
  description: "name",
  label: "name",
  brand: "producer",
  "wine producer": "producer",
  domaine: "producer",
  estate: "producer",
  // Classification
  varietals: "varietal",
  "grape variety": "varietal",
  "sub region": "region",
  subregion: "region",
  "sub-region": "region",
  // Physical
  "container size": "size_ml",
  "bottle volume": "size_ml",
  "unit size": "size_ml",
  "pack size": "format",
  // Counts — every one of these is a bottle count, never a value
  "on hand": "quantity",
  "on-hand": "quantity",
  onhand: "quantity",
  "quantity on hand": "quantity",
  "qty on hand": "quantity",
  count: "quantity",
  "bottle count": "quantity",
  "units": "quantity",
  // Money — per-unit only
  "bottle cost": "unit_cost",
  "cost per bottle": "unit_cost",
  "cost per unit": "unit_cost",
  "each cost": "unit_cost",
  "purchase price": "unit_cost",
  // Placement
  "storage location": "bin",
  "storage area": "bin",
  shelf: "bin",
  rack: "bin",
  area: "section",
  category: "section",
  "wine type": "section",
};

const PRESETS: Record<SourcePresetId, SourcePreset> = {
  generic: {
    id: "generic",
    label: "Generic spreadsheet",
    confidence: "conventional",
    provenance:
      "Column labels common to cellar and beverage-inventory exports; not any one vendor's schema. Applied as the fallback for every file, after HEADER_SYNONYMS and after any detected vendor preset.",
    columns: GENERIC_COLUMNS,
    // Never detected — it is the floor every file already stands on.
    signature: [],
  },
  cellartracker: {
    id: "cellartracker",
    label: "CellarTracker",
    confidence: "documented",
    provenance:
      "CellarTracker's published export documentation plus a third-party enumeration of its 59-column export (verified 2026-08-30). Thin on purpose: HEADER_SYNONYMS already maps Producer, Wine, Vintage, Varietal, Region, Country, Size, Quantity, Price, Currency, Location and Bin correctly, so this fills only the four columns it does not.",
    columns: {
      // "iWine" is CellarTracker's own wine id — not a field this importer
      // has, but the signature that identifies the file.
      totalquantity: "quantity",
      mastervarietal: "varietal",
      appellation: "region",
      locale: "region",
    },
    // Unique to CellarTracker; no other export in this category uses it.
    signature: ["iwine"],
  },
  vivino: {
    id: "vivino",
    label: "Vivino",
    confidence: "unverified",
    provenance:
      "Vivino publishes NO structured CSV cellar export (verified 2026-08-30). The files that circulate come from third-party exporter scripts whose columns differ from each other, so there is no single schema to encode. Declared with no columns and no signature so it can never fire; a real Vivino export handed to us fills this in as a data change.",
    columns: {},
    signature: [],
  },
  binwise: {
    id: "binwise",
    label: "BinWise",
    confidence: "unverified",
    provenance:
      "BinWise Pro exports inventory to CSV but publishes no column schema (verified 2026-08-30). No columns invented; the generic profile carries a BinWise export today.",
    columns: {},
    signature: [],
  },
  bevspot: {
    id: "bevspot",
    label: "BevSpot",
    confidence: "unverified",
    provenance:
      "No public export schema (verified 2026-08-30). Kept alongside `bevrly` because BevSpot is a real product in this category, not because the field walk pointed at it.",
    columns: {},
    signature: [],
  },
  bevrly: {
    id: "bevrly",
    label: "Bevrly",
    confidence: "unverified",
    provenance:
      "The field-walk vendor. Devin was heard saying \"Beverly\"; docs/evals/README.md already calls Terroir a \"Bevrly-response build\", and Bevrly is a real restaurant beverage-inventory scanner app — a far better fit than the decision record's original low-confidence BevSpot guess. Its export schema is not published (verified 2026-08-30), so no columns are invented here.",
    columns: {},
    signature: [],
  },
};

export function sourcePreset(id: SourcePresetId): SourcePreset {
  return PRESETS[id];
}

export function allSourcePresets(): SourcePreset[] {
  return SOURCE_PRESET_IDS.map((id) => PRESETS[id]);
}

/**
 * Which vendor wrote this file, judged only from its header row.
 *
 * Detection is deliberately a pure function of the header, never of a
 * client-supplied claim: the same bytes always produce the same mapping, on
 * preview and on confirm, on a single-file upload and on every chunk of a
 * split one. That is what lets this ship with no new request field and no
 * new `content_sha256` namespace — the preset is already inside the digest,
 * because the header is.
 *
 * Returns null when nothing matched, which is the common case and not an
 * error: the generic profile handles it.
 */
export function detectSourcePreset(header: string[]): SourcePresetId | null {
  const present = new Set(header.map((name) => name.trim().toLowerCase()));
  let best: { id: SourcePresetId; hits: number } | null = null;
  for (const id of SOURCE_PRESET_IDS) {
    const { signature } = PRESETS[id];
    if (signature.length === 0) continue;
    const hits = signature.filter((name) => present.has(name)).length;
    // Ordered iteration plus a strict `>` makes ties deterministic: the
    // earliest preset in SOURCE_PRESET_IDS wins, always.
    if (hits > 0 && (best === null || hits > best.hits)) best = { id, hits };
  }
  return best?.id ?? null;
}

/**
 * The additive lookup a detected source contributes, generic profile
 * included. The vendor's own columns win over the generic ones; both lose
 * to HEADER_SYNONYMS at the call site.
 */
export function presetColumns(
  detected: SourcePresetId | null,
): Readonly<Record<string, CanonicalHeader>> {
  if (detected === null || detected === "generic") return GENERIC_COLUMNS;
  return { ...GENERIC_COLUMNS, ...PRESETS[detected].columns };
}
