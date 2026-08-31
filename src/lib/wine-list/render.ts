/**
 * ARCH-020: shared filter + sort + 86'd-exclusion pipeline for the
 * public /list/[slug] page and the PDF route. Both used to reimplement
 * the same three-step flow inline:
 *   1. sort sections by position
 *   2. drop sections with no items
 *   3. within each section, drop items that either have no wine or
 *      whose wine is 86'd, then sort by position
 *
 * Drifting copies of "the same public rendering rules" across two
 * consumers was a recipe for the PDF showing a wine the public list
 * hid (or vice versa). One helper, one source of truth.
 *
 * BND-173: eightysixStrategy controls how 86'd wines appear.
 *   'hide' (default) — remove 86'd wines entirely
 *   'mark'           — keep them with is_marked_eightysixed = true
 */

import { wineTitle } from "@/lib/wine-display-name";

type ItemBase = {
  position: number;
  wines: { is_eightysixed: boolean } | null;
};

type SectionShape = {
  name: string;
  position: number;
  wine_list_items: ItemBase[];
};

/**
 * Narrowed item whose wines is guaranteed non-null.
 * Consumers can use this to drop the `item.wines!` non-null assertion.
 * When eightysixStrategy is 'mark', 86'd wines are included with
 * `is_marked_eightysixed = true` for gray/strikethrough rendering.
 */
export type RenderableItem<TItem extends ItemBase> = TItem & {
  wines: NonNullable<TItem["wines"]>;
  /** True when the item's wine is 86'd and the strategy is 'mark'.
   *  Consumers should render these with muted styling. */
  is_marked_eightysixed: boolean;
};

export type EightysixStrategy = "hide" | "mark";

export interface RenderWineListSectionsOptions {
  /** Strategy for handling 86'd wines. Defaults to 'hide'. */
  eightysixStrategy?: EightysixStrategy;
}

/**
 * Apply the public-facing rendering rules to a raw wine_list_sections
 * embed. Pure function — no IO, no mutation of inputs. Preserves any
 * extra section-level fields (e.g. `id`) so consumers that key by
 * id don't have to reach into the untransformed input.
 *
 * Item type is extracted directly from the passed section type via
 * `TSection["wine_list_items"][number]` — keeps callers from needing
 * to duplicate the item type, and TS infers it from the passed array
 * rather than falling back to the ItemBase constraint.
 *
 * @returns sections sorted by position, each with items sorted by
 *   position. 86'd/no-wine items are filtered out when strategy is
 *   'hide'; kept with is_marked_eightysixed = true when 'mark'.
 *   Sections that end up empty are dropped.
 */
export function renderWineListSections<TSection extends SectionShape>(
  sections: TSection[],
  options?: RenderWineListSectionsOptions,
): Array<
  Omit<TSection, "wine_list_items"> & {
    items: RenderableItem<TSection["wine_list_items"][number]>[];
  }
> {
  const strategy: EightysixStrategy = options?.eightysixStrategy ?? "hide";
  type Item = TSection["wine_list_items"][number];
  type Rendered = Omit<TSection, "wine_list_items"> & {
    items: RenderableItem<Item>[];
  };
  return [...sections]
    .sort((a, b) => a.position - b.position)
    .map((s) => {
      const { wine_list_items, ...rest } = s;
      const items = [...wine_list_items]
        .filter((it): it is RenderableItem<Item> => {
          // Always drop items with no wine (orphaned references).
          if (it.wines == null) return false;
          // When strategy is 'hide', drop 86'd wines. When 'mark',
          // keep them so they render gray/strikethrough.
          if (strategy === "hide" && it.wines.is_eightysixed) return false;
          return true;
        })
        .map((it) => ({
          ...it,
          is_marked_eightysixed: it.wines.is_eightysixed,
        })) as RenderableItem<Item>[];
      items.sort((a, b) => a.position - b.position);
      return { ...rest, items } as unknown as Rendered;
    })
    .filter((s) => s.items.length > 0);
}

/**
 * The one name a guest sees on a list line — on screen, in print, and in the
 * PDF.
 *
 * BUG-01: those three surfaces each composed `${producer} ${name}` for
 * themselves, and `name` still contains the producer on 98% of production's
 * rows — a CSV import wrote it there, and migration `0137` recovered the
 * producer into its own column while correctly leaving `name` alone. So all
 * three printed the winery twice. Composing the label here, in the module that
 * already exists to stop the public rendering rules drifting between exactly
 * these consumers, is what keeps a fourth surface from getting it wrong on its
 * own.
 *
 * `name_override` always wins and is never rewritten: it is the owner's own
 * words for this bottle on this list, not a stored column to be repaired.
 */
export function wineListItemLabel(item: {
  name_override: string | null;
  wines: { producer: string; name: string };
}): string {
  const { producer, name } = item.wines;
  return item.name_override ?? wineTitle(producer, name);
}
