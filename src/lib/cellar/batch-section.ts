import { readApiError } from "@/lib/api/client-error";

export const CELLAR_BATCH_SECTION_LIMIT = 200;

export class CellarBatchSectionError extends Error {
  constructor(
    message: string,
    readonly assignedCount: number,
  ) {
    super(message);
    this.name = "CellarBatchSectionError";
  }
}

export function chunkCellarWineIds(wineIds: string[]): string[][] {
  const chunks: string[][] = [];
  for (
    let offset = 0;
    offset < wineIds.length;
    offset += CELLAR_BATCH_SECTION_LIMIT
  ) {
    chunks.push(
      wineIds.slice(offset, offset + CELLAR_BATCH_SECTION_LIMIT),
    );
  }
  return chunks;
}

export async function assignCellarWineSections(input: {
  wineIds: string[];
  section: string;
  request?: typeof fetch;
}): Promise<number> {
  const request = input.request ?? fetch;
  let assignedCount = 0;

  for (const wineIds of chunkCellarWineIds(input.wineIds)) {
    let response: Response;
    try {
      response = await request("/api/cellar/batch-section", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wine_ids: wineIds,
          section: input.section,
        }),
      });
    } catch (error) {
      throw new CellarBatchSectionError(
        error instanceof Error ? error.message : "Batch assign failed.",
        assignedCount,
      );
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new CellarBatchSectionError(
        readApiError(
          payload,
          `Batch assign failed (${response.status}).`,
        ).message,
        assignedCount,
      );
    }
    assignedCount += wineIds.length;
  }

  return assignedCount;
}
