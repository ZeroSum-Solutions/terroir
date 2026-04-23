/**
 * DEBT-013: shared shapes for the nested wine_list_sections +
 * wine_list_items + wines embed that the PDF route and the public
 * /list/[slug] page both select against.
 *
 * Prior to this, both consumers wrote their own `as unknown as
 * Array<...>` cast inline, and the two shapes drifted (the PDF
 * cast was missing the wine fields the public list cast had, and
 * the public list cast was missing the pour-size fields the PDF
 * cast had). Regenerating the Database type doesn't help either,
 * because PostgREST's nested-embed runtime response isn't directly
 * representable in the Supabase generator's emit.
 *
 * The generic `WineListSectionEmbed<TItem>` lets each consumer keep
 * its own narrower item shape (TItem) while reusing the outer
 * section shape that's identical across all callers.
 */

export type WineListSectionEmbed<TItem> = {
  id?: string;
  name: string;
  position: number;
  wine_list_items: TItem[];
};
