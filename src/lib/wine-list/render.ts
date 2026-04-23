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
 */

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
 * Narrowed item whose wines is guaranteed non-null + not 86'd.
 * Consumers can use this to drop the `item.wines!` non-null assertion.
 */
export type RenderableItem<TItem extends ItemBase> = TItem & {
  wines: NonNullable<TItem["wines"]>;
};

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
 *   position and 86'd/no-wine items filtered out. Sections that end
 *   up empty are dropped.
 */
export function renderWineListSections<TSection extends SectionShape>(
  sections: TSection[],
): Array<
  Omit<TSection, "wine_list_items"> & {
    items: RenderableItem<TSection["wine_list_items"][number]>[];
  }
> {
  type Item = TSection["wine_list_items"][number];
  type Rendered = Omit<TSection, "wine_list_items"> & {
    items: RenderableItem<Item>[];
  };
  return [...sections]
    .sort((a, b) => a.position - b.position)
    .map((s) => {
      const { wine_list_items, ...rest } = s;
      const items = [...wine_list_items].filter(
        (it): it is RenderableItem<Item> =>
          it.wines != null && !it.wines.is_eightysixed,
      );
      items.sort((a, b) => a.position - b.position);
      return { ...rest, items } as unknown as Rendered;
    })
    .filter((s) => s.items.length > 0);
}
