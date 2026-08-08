export const CELLAR_COLOURS = [
  "red",
  "white",
  "rose",
  "sparkling",
  "dessert",
  "fortified",
] as const;

export type CellarColour = (typeof CELLAR_COLOURS)[number];
export type CellarSort = "name" | "price" | "vintage" | "quantity";

export type CellarInventoryViewRow = {
  name: string;
  producer: string;
  vintage: number | null;
  varietal: string | null;
  region: string | null;
  country: string | null;
  colour: string | null;
  sealed_count: number;
  has_inventory_record: boolean;
  current_unit_cost: number | null;
  is_eightysixed: boolean;
  drink_window_start: number | null;
  drink_window_end: number | null;
};

export type CellarInventoryViewOptions = {
  query?: string;
  colour?: CellarColour | "all";
  location?: string;
  vintageMin?: number | null;
  vintageMax?: number | null;
  sort?: CellarSort;
};

function normalize(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

export function normalizeCellarColour(
  value: string | null | undefined,
): CellarColour | null {
  const normalized = normalize(value);
  if (normalized === "rose") return "rose";
  return CELLAR_COLOURS.find((colour) => colour === normalized) ?? null;
}

export function matchesCellarInventoryView(
  row: CellarInventoryViewRow,
  options: CellarInventoryViewOptions,
): boolean {
  const query = normalize(options.query);
  if (
    query &&
    ![
      row.name,
      row.producer,
      row.varietal,
      row.region,
      row.vintage == null ? "" : String(row.vintage),
    ].some((value) => normalize(value).includes(query))
  ) {
    return false;
  }

  if (
    options.colour &&
    options.colour !== "all" &&
    normalizeCellarColour(row.colour) !== options.colour
  ) {
    return false;
  }

  const location = normalize(options.location);
  if (
    location &&
    normalize(row.region) !== location &&
    normalize(row.country) !== location
  ) {
    return false;
  }

  if (options.vintageMin != null && (row.vintage == null || row.vintage < options.vintageMin)) {
    return false;
  }
  if (options.vintageMax != null && (row.vintage == null || row.vintage > options.vintageMax)) {
    return false;
  }

  return true;
}

function compareNullableNumber(
  left: number | null,
  right: number | null,
  direction: "asc" | "desc",
): number {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  return direction === "asc" ? left - right : right - left;
}

export function compareCellarInventoryRows<T extends CellarInventoryViewRow>(
  left: T,
  right: T,
  sort: CellarSort,
): number {
  let result = 0;
  switch (sort) {
    case "price":
      result = compareNullableNumber(left.current_unit_cost, right.current_unit_cost, "desc");
      break;
    case "vintage":
      result = compareNullableNumber(left.vintage, right.vintage, "desc");
      break;
    case "quantity":
      result = right.sealed_count - left.sealed_count;
      break;
    case "name":
    default:
      result = left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
      break;
  }
  return result || left.producer.localeCompare(right.producer, undefined, { sensitivity: "base" });
}

export function applyCellarInventoryView<T extends CellarInventoryViewRow>(
  rows: readonly T[],
  options: CellarInventoryViewOptions,
): T[] {
  const sort = options.sort ?? "name";
  return rows
    .filter((row) => matchesCellarInventoryView(row, options))
    .sort((left, right) => compareCellarInventoryRows(left, right, sort));
}

export function isCellarLowStock(
  row: Pick<CellarInventoryViewRow, "has_inventory_record" | "sealed_count" | "is_eightysixed">,
  threshold: number,
): boolean {
  return (
    row.has_inventory_record &&
    !row.is_eightysixed &&
    row.sealed_count < Math.max(0, threshold)
  );
}

export function isEnteringOrInDrinkWindow(
  row: Pick<CellarInventoryViewRow, "drink_window_start" | "drink_window_end" | "is_eightysixed">,
  currentYear = new Date().getFullYear(),
): boolean {
  if (row.is_eightysixed || row.drink_window_start == null || row.drink_window_end == null) {
    return false;
  }
  return currentYear >= row.drink_window_start - 1 && currentYear <= row.drink_window_end;
}

export function isPastDrinkWindow(
  row: Pick<CellarInventoryViewRow, "drink_window_end" | "is_eightysixed">,
  currentYear = new Date().getFullYear(),
): boolean {
  return !row.is_eightysixed && row.drink_window_end != null && currentYear > row.drink_window_end;
}
