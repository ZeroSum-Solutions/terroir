import { readApiError } from "@/lib/api/client-error";
import { createIdempotentCommandStore } from "@/lib/api/idempotency-client";

export const CELLAR_BATCH_SECTION_LIMIT = 200;

type IdempotentCommandStore = ReturnType<
  typeof createIdempotentCommandStore
>;

type CellarSectionResult = {
  wine_id: string;
  section: string | null;
};

type CellarBatchSectionResult = {
  updated: number;
  section: string;
};

export class CellarSectionCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CellarSectionCommandError";
  }
}

export class CellarBatchSectionError extends Error {
  constructor(
    message: string,
    readonly assignedCount: number,
  ) {
    super(message);
    this.name = "CellarBatchSectionError";
  }
}

export function chunkCellarWineIds(wineIds: readonly string[]): string[][] {
  const canonicalWineIds = [...wineIds].sort();
  const chunks: string[][] = [];
  for (
    let offset = 0;
    offset < canonicalWineIds.length;
    offset += CELLAR_BATCH_SECTION_LIMIT
  ) {
    chunks.push(
      canonicalWineIds.slice(
        offset,
        offset + CELLAR_BATCH_SECTION_LIMIT,
      ),
    );
  }
  return chunks;
}

export async function assignCellarWineSection(input: {
  wineId: string;
  section: string | null;
  commands: IdempotentCommandStore;
}): Promise<CellarSectionResult> {
  const section = normalizeCellarSection(input.section);
  const { response, data } = await input.commands.json<unknown>({
    slot: `cellar:section:${input.wineId}`,
    url: `/api/cellar/${input.wineId}/section`,
    method: "PATCH",
    json: { section },
  });

  if (!response.ok) {
    throw new CellarSectionCommandError(
      readApiError(
        data,
        `Failed to move wine (${response.status}).`,
      ).message,
    );
  }
  if (
    !data ||
    typeof data !== "object" ||
    (data as { wine_id?: unknown }).wine_id !== input.wineId ||
    (data as { section?: unknown }).section !== section
  ) {
    throw new CellarSectionCommandError(
      "The server returned an invalid cellar section result.",
    );
  }
  return data as CellarSectionResult;
}

function normalizeCellarSection(section: string): string;
function normalizeCellarSection(section: null): null;
function normalizeCellarSection(section: string | null): string | null;
function normalizeCellarSection(section: string | null): string | null {
  if (section === null) return null;
  const normalized = section.trim();
  if (normalized.length < 1 || normalized.length > 100) {
    throw new CellarSectionCommandError(
      "Cellar section must be between 1 and 100 characters.",
    );
  }
  return normalized;
}

export async function assignCellarWineSections(input: {
  wineIds: readonly string[];
  section: string;
  commands: IdempotentCommandStore;
}): Promise<number> {
  const section = normalizeCellarSection(input.section);
  let assignedCount = 0;

  for (const wineIds of chunkCellarWineIds(input.wineIds)) {
    let result: { response: Response; data: unknown };
    try {
      result = await input.commands.json<unknown>({
        slot: cellarBatchSectionSlot(wineIds),
        url: "/api/cellar/batch-section",
        method: "POST",
        json: {
          wine_ids: wineIds,
          section,
        },
      });
    } catch (error) {
      throw new CellarBatchSectionError(
        error instanceof Error ? error.message : "Batch assign failed.",
        assignedCount,
      );
    }
    if (!result.response.ok) {
      throw new CellarBatchSectionError(
        readApiError(
          result.data,
          `Batch assign failed (${result.response.status}).`,
        ).message,
        assignedCount,
      );
    }
    if (
      !isCellarBatchSectionResult(
        result.data,
        wineIds.length,
        section,
      )
    ) {
      throw new CellarBatchSectionError(
        "The server returned an invalid cellar batch result.",
        assignedCount,
      );
    }
    assignedCount += wineIds.length;
  }

  return assignedCount;
}

function cellarBatchSectionSlot(wineIds: readonly string[]): string {
  const firstId = wineIds[0] ?? "empty";
  const lastId = wineIds.at(-1) ?? "empty";
  return `cellar:batch-section:${firstId}:${lastId}:${wineIds.length}`;
}

function isCellarBatchSectionResult(
  value: unknown,
  expectedUpdated: number,
  expectedSection: string,
): value is CellarBatchSectionResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as {
    updated?: unknown;
    section?: unknown;
  };
  return (
    candidate.updated === expectedUpdated &&
    candidate.section === expectedSection
  );
}
