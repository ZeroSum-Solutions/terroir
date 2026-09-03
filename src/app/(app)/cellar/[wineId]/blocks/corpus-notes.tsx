/**
 * The two reasons the taste sections are missing, kept distinct on purpose.
 */

/**
 * "We looked and this wine isn't in the reference" is a fact about the wine,
 * and saying it during an outage is a lie that repeats itself on every reload.
 */
export function CorpusUnavailableNote() {
  return (
    <p className="mt-xl rounded-card border border-rule bg-surface-sunken px-lg py-md text-body-sm text-grey">
      The reference corpus couldn&rsquo;t be reached, so taste structure, grapes
      and pairings aren&rsquo;t shown for this bottle. That&rsquo;s a problem at
      our end rather than a gap in the reference — try again shortly.
    </p>
  );
}

/**
 * The common case, stated plainly. The corpus is consumer-review breadth and a
 * restaurant list skews to trade bottlings, so most wines will not be in it —
 * saying so is better than a page of empty sections.
 *
 * BUG-01, from the other side. The same CSV import that embedded producers in
 * `name` also left 321 production wines — 23% of that cellar — with an EMPTY
 * `producer`, and migration `0137` deliberately left them empty rather than
 * guess. Naming that blank put a hole in the sentence: "No reference entry
 * matched  closely enough to trust", with two spaces where the winery should
 * be. With no producer to name, the sentence names the bottle instead — the
 * phrasing CorpusUnavailableNote above already uses for the same shortfall.
 */
export function NoProfileNote({ producer }: { producer: string }) {
  const subject = producer.trim();
  return (
    <p className="mt-xl rounded-card border border-rule bg-surface-sunken px-lg py-md text-body-sm text-grey">
      No reference entry matched {subject === "" ? "this wine" : subject}{" "}
      closely enough to trust, so taste structure, grapes and pairings
      aren&rsquo;t shown for this bottle.
    </p>
  );
}
