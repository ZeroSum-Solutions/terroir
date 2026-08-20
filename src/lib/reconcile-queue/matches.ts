import { parseBottleFormat } from "./format";
import type {
  FieldSuggestionBasis,
  QueueSuggestion,
  WineMatchCandidate,
  WineMatchIdentity,
} from "./types";

const FIELD_BASIS: FieldSuggestionBasis = {
  kind: "field_match",
  fields: ["producer", "cuvee", "vintage", "format"],
};

function normalizedText(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLocaleLowerCase("en-US");
  return normalized ? normalized : null;
}

function lineText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function wineMatchIdentityFromLine(
  line: Readonly<Record<string, unknown>>,
): WineMatchIdentity {
  const format = line.format;
  return {
    lwin: lineText(line.lwin ?? line.lwin_id),
    producer: lineText(line.producer),
    cuvee: lineText(line.name ?? line.cuvee),
    vintage: typeof line.vintage === "number" ? line.vintage : null,
    format: typeof format === "string" || typeof format === "number"
      ? format
      : null,
  };
}

function exactFieldMatch(scan: WineMatchIdentity, candidate: WineMatchCandidate): boolean {
  const scanProducer = normalizedText(scan.producer);
  const scanCuvee = normalizedText(scan.cuvee);
  const candidateProducer = normalizedText(candidate.producer);
  const candidateCuvee = normalizedText(candidate.cuvee);
  const scanFormat = scan.format == null ? null : parseBottleFormat(scan.format);
  const candidateFormat = candidate.format == null ? null : parseBottleFormat(candidate.format);
  return (
    scanProducer !== null &&
    scanCuvee !== null &&
    scanProducer === candidateProducer &&
    scanCuvee === candidateCuvee &&
    scan.vintage != null &&
    scan.vintage === candidate.vintage &&
    scanFormat !== null &&
    scanFormat === candidateFormat
  );
}

function toSuggestion(
  candidate: WineMatchCandidate,
  basis: QueueSuggestion["basis"],
): QueueSuggestion {
  return {
    wineId: candidate.wineId,
    title: candidate.title,
    ...(candidate.deepLink ? { deepLink: candidate.deepLink } : {}),
    basis,
  };
}

function onlyCandidate(candidates: WineMatchCandidate[]): WineMatchCandidate | null {
  return candidates.length === 1 ? candidates[0] : null;
}

export function suggestWineMatch(
  scan: WineMatchIdentity,
  candidates: readonly WineMatchCandidate[],
): QueueSuggestion | null {
  const lwin = scan.lwin?.trim();
  if (lwin) {
    const candidate = onlyCandidate(candidates.filter((item) => item.lwin?.trim() === lwin));
    return candidate ? toSuggestion(candidate, { kind: "lwin", lwin }) : null;
  }
  const candidate = onlyCandidate(candidates.filter((item) => exactFieldMatch(scan, item)));
  return candidate ? toSuggestion(candidate, FIELD_BASIS) : null;
}
