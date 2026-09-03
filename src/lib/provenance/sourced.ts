/**
 * Provenance as a type.
 *
 * Every derived number on the wine page carries where it came from, so a
 * component cannot render one without also having its basis in hand. This is
 * the type half of the contract in §4.1 of
 * docs/superpowers/specs/2026-09-03-wine-page-design.md; the other half is that
 * each display block has a test asserting its basis sentence renders.
 *
 * There is deliberately NO "estimate" basis. Values with no source are removed
 * rather than labelled — a page whose selling point is trustworthiness cannot
 * carry a fabricated number, and a caption does not fix that. If something one
 * day genuinely needs an estimate basis, it is added then, with the argument
 * for it written down.
 */
export type Basis =
  /** Aggregated from this house's own notes. `notes` counts CONFIRMED notes only. */
  | { kind: "house"; notes: number }
  /** A published source: a producer or importer sheet, or a retailer listing. */
  | { kind: "sourced"; name: string; url: string; asOf: string }
  /** A reference corpus already in the database, e.g. X-Wines. */
  | { kind: "corpus"; name: string }
  /** Set by hand by someone at this restaurant, which outranks every source. */
  | { kind: "override"; by: string; at: string }
  /** Computed from the restaurant's own records — inventory, pours, lists. */
  | { kind: "measured"; asOf: string };

export type Sourced<T> = { value: T; basis: Basis };

/**
 * A score and the scale it is on. X-Wines averages are 1–5 and critics are on
 * 100, and a side-by-side that silently compares 4.2 with 92 is worse than
 * showing no comparison at all.
 */
export type Score = { n: number; scale: 100 | 5 };

/** Convenience for the common case of wrapping a value that is always present. */
export function sourced<T>(value: T, basis: Basis): Sourced<T> {
  return { value, basis };
}
