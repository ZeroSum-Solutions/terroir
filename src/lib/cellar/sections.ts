import { z } from "zod";

const CellarLabelsSchema = z
  .object({
    sections: z.array(
      z.object({
        id: z.string(),
        name: z.string().trim().min(1).max(100),
      }),
    ),
  })
  .passthrough();

export type CellarSection = {
  id: string;
  name: string;
};

const SECTION_DROP_PREFIX = "section-";
const WINE_DRAG_PREFIX = "wine-";
export const UNCATEGORIZED_SECTION_KEY = "__uncategorized__";

export function parseCellarSections(labels: unknown): CellarSection[] {
  const parsed = CellarLabelsSchema.safeParse(labels);
  return parsed.success ? parsed.data.sections : [];
}

export function isCellarSectionAssignable(row: {
  has_inventory_record: boolean;
}): boolean {
  return row.has_inventory_record;
}

export function cellarSectionDropId(sectionKey: string): string {
  return `${SECTION_DROP_PREFIX}${sectionKey}`;
}

export function parseCellarSectionDropId(
  dropId: string,
): string | null | undefined {
  if (!dropId.startsWith(SECTION_DROP_PREFIX)) return undefined;
  const sectionKey = dropId.slice(SECTION_DROP_PREFIX.length);
  if (!sectionKey) return undefined;
  return sectionKey === UNCATEGORIZED_SECTION_KEY ? null : sectionKey;
}

export function cellarWineDragId(wineId: string): string {
  return `${WINE_DRAG_PREFIX}${wineId}`;
}

export function parseCellarWineDragId(dragId: string): string | undefined {
  if (!dragId.startsWith(WINE_DRAG_PREFIX)) return undefined;
  const wineId = dragId.slice(WINE_DRAG_PREFIX.length);
  return wineId || undefined;
}
