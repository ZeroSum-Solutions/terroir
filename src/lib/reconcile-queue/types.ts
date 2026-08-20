export type ReconcileQueueKind =
  | "unplaced"
  | "unmatched_scan"
  | "duplicate_suspect"
  | "ambiguous_lineage";

export type QueueActionType =
  | "place_bin"
  | "match_scan"
  | "link_lineage"
  | "dismiss";

export type QueueActionMetadata = {
  type: QueueActionType;
  label: string;
  targetId?: string;
  payload?: Readonly<Record<string, unknown>>;
};

export type LwinSuggestionBasis = {
  kind: "lwin";
  lwin: string;
};

export type FieldSuggestionBasis = {
  kind: "field_match";
  fields: readonly ["producer", "cuvee", "vintage", "format"];
};

export type QueueSuggestion = {
  wineId: string;
  title: string;
  deepLink?: string;
  basis: LwinSuggestionBasis | FieldSuggestionBasis;
};

export type QueueSourceInput = {
  subjectTable: string;
  subjectId: string;
  title: string;
  detail: string;
  units: number;
  unitCost: number;
  wineId?: string;
  deepLink?: string;
  suggestion?: QueueSuggestion;
  action?: QueueActionMetadata;
  metadata?: Readonly<Record<string, unknown>>;
};

export type ReconcileQueueRow = QueueSourceInput & {
  id: string;
  kind: ReconcileQueueKind;
  atRisk: number;
};

export type ReconcileQueueSources = {
  unplaced: readonly QueueSourceInput[];
  unmatchedScans: readonly QueueSourceInput[];
  duplicateSuspects: readonly QueueSourceInput[];
  ambiguousLineages: readonly QueueSourceInput[];
};

export type ReconcileQueueSummary = {
  itemCount: number;
  unitCount: number;
  atRisk: number;
};

export type ReconcileQueue = {
  rows: ReconcileQueueRow[];
  summary: ReconcileQueueSummary;
};

export type BottleFormatInput = string | number;

export type WineMatchIdentity = {
  lwin?: string | null;
  producer?: string | null;
  cuvee?: string | null;
  vintage?: number | null;
  format?: BottleFormatInput | null;
};

export type WineMatchCandidate = WineMatchIdentity & {
  wineId: string;
  title: string;
  deepLink?: string;
};
