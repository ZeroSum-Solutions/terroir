/**
 * The operational badges on a wine.
 *
 * Pure and I/O-free on purpose: `resolveCellarContext` does the querying and
 * hands this a plain object, so the whole badge surface is testable without a
 * database and every boundary condition below is a unit test rather than a
 * fixture.
 *
 * Each badge carries the sentence shown when a buyer taps it. A badge that
 * cannot say why it fired is a badge nobody trusts twice, and an untrusted
 * badge row is worse than none — it trains people to ignore the page.
 *
 * There are five, not six. Mis-binned was specified and dropped: its two
 * clauses were different things OR'd together. A wine stored in more than one
 * bin is normal (the by-the-glass well plus the reserve cage), and
 * `bin_location` text drifting from its `bins.code` is denormalised-field
 * drift belonging to a data-quality sweep, not a warning on a wine page.
 * See D14 in docs/superpowers/specs/2026-09-03-wine-page-design.md.
 */
import { getDrinkWindowStatus, DRINK_NOW_THRESHOLD_YEARS } from "@/lib/drink-window/status";

export type BadgeKind =
  | "drink_now"
  | "last_bottle"
  | "slow_mover"
  | "below_cost"
  | "off_list";

export type Badge = { kind: BadgeKind; label: string; rule: string };

export type BadgeInput = {
  year: number;
  /** The resolved window, or null when none is trustworthy. */
  window: { start: number; end: number } | null;
  /**
   * Where that window came from. Only "sourced" and "override" may raise
   * Drink now: an inferred window is a guess, and telling staff to open a
   * bottle on the strength of a guess is the defect the retirement removes.
   */
  windowBasis: "sourced" | "override" | "inferred" | null;
  /** Units of the format the wine is actually sold in. */
  sellingFormatUnits: number;
  /** Units of every other format, counted separately and never conflated. */
  otherFormatUnits: number;
  /** When this wine was last put away — the clock slow-mover measures from. */
  lastPutAwayAt: string | null;
  /** The last DEPLETING event. Waste, tastings and adjustments are excluded. */
  lastDepletionAt: string | null;
  deadStockDays: number;
  /** The published price. Hidden, unavailable and glass-only rows are excluded upstream. */
  publishedBottlePrice: number | null;
  /** Weighted average across non-zero lots, or null when no cost is known. */
  weightedUnitCost: number | null;
  listedAndOrderable: boolean;
};

export function computeBadges(input: BadgeInput): Badge[] {
  const badges: Badge[] = [];
  const onHand = input.sellingFormatUnits + input.otherFormatUnits;

  // ── Drink now ───────────────────────────────────────────────────────────
  // Reuses getDrinkWindowStatus rather than comparing years here. That helper
  // already means "within DRINK_NOW_THRESHOLD_YEARS of the window closing",
  // and its docstring says it is the single source of truth precisely so the
  // cellar chip, the list filter and the alert cannot drift apart. A second
  // inline comparison would be that drift.
  if (
    input.window !== null &&
    (input.windowBasis === "sourced" || input.windowBasis === "override") &&
    getDrinkWindowStatus(input.window.start, input.window.end, input.year) === "drink_now"
  ) {
    const whose =
      input.windowBasis === "override" ? "the window the house set" : "the sourced window";
    badges.push({
      kind: "drink_now",
      label: "Drink now",
      rule: `${input.year} is within ${DRINK_NOW_THRESHOLD_YEARS} years of ${whose} closing in ${input.window.end}.`,
    });
  }

  // ── Last bottle ─────────────────────────────────────────────────────────
  // Counts the selling format only. One 750 left beside four magnums is still
  // the last bottle of the thing on the list, and a badge that counts them
  // together would stay silent through the sale that empties it.
  if (input.sellingFormatUnits === 1) {
    badges.push({
      kind: "last_bottle",
      label: "Last bottle",
      rule:
        input.otherFormatUnits > 0
          ? `One left in the selling format. The ${input.otherFormatUnits} in other formats are counted separately.`
          : "One left on hand.",
    });
  }

  // ── Slow mover ──────────────────────────────────────────────────────────
  // Measured from the last put-away, not from a sliding window over pour rows.
  // "No pours in 90 days" fires on stock received yesterday, which is how a
  // badge row becomes noise on its first week.
  if (onHand > 0 && input.lastPutAwayAt !== null) {
    const since = input.lastDepletionAt ?? input.lastPutAwayAt;
    const days = daysBetween(since, input.year);
    if (days !== null && days > input.deadStockDays) {
      badges.push({
        kind: "slow_mover",
        label: "Slow mover",
        rule: input.lastDepletionAt
          ? `Nothing has sold in ${days} days; your dead-stock threshold is ${input.deadStockDays}.`
          : `Nothing has sold since it was put away ${days} days ago; your dead-stock threshold is ${input.deadStockDays}.`,
      });
    }
  }

  // ── Below cost ──────────────────────────────────────────────────────────
  // A null or zero price is "not priced", never "priced at nothing", and a
  // null cost must not read as a healthy margin. Both stay silent.
  if (
    input.publishedBottlePrice !== null &&
    input.publishedBottlePrice > 0 &&
    input.weightedUnitCost !== null &&
    input.publishedBottlePrice < input.weightedUnitCost
  ) {
    badges.push({
      kind: "below_cost",
      label: "Below cost",
      rule: `Listed at ${input.publishedBottlePrice} against a weighted average cost of ${input.weightedUnitCost} across your lots.`,
    });
  }

  // ── Off list ────────────────────────────────────────────────────────────
  // Only meaningful when there is something to sell. A wine with no stock is
  // not off-list; it is simply gone.
  if (onHand > 0 && !input.listedAndOrderable) {
    badges.push({
      kind: "off_list",
      label: "Off list",
      rule: `${onHand} on hand, but this wine is on no list a guest can order from.`,
    });
  }

  return badges;
}

/**
 * Whole days between an ISO date and the end of `year`. Returns null on an
 * unparseable date rather than a wrong number, so a bad row goes quiet instead
 * of raising a confident false badge.
 */
function daysBetween(iso: string, year: number): number | null {
  const then = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(then.getTime())) return null;
  const now = new Date(Date.UTC(year, 8, 3));
  return Math.floor((now.getTime() - then.getTime()) / 86_400_000);
}
