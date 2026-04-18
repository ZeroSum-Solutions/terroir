import type { Tables } from "@/types/database";

export type WineList = Tables<"wine_lists">;
export type WineListSection = Tables<"wine_list_sections">;
export type WineListItem = Tables<"wine_list_items">;
export type Wine = Tables<"wines">;

export type WineListWithCount = WineList & {
  wine_count: number;
};

export type WineListItemWithWine = WineListItem & {
  wines: Wine;
};

export type SectionWithItems = WineListSection & {
  wine_list_items: WineListItemWithWine[];
};

export type WineListFull = WineList & {
  wine_list_sections: SectionWithItems[];
};

export const DEFAULT_SECTIONS = [
  "Sparkling",
  "White",
  "Rosé",
  "Red",
  "Dessert & Fortified",
] as const;

export const TEMPLATES = ["classic", "modern", "minimal"] as const;
export type Template = (typeof TEMPLATES)[number];
