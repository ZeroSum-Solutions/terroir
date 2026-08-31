// SD-41 — the blank-producer guard at the import boundary.
//
// ── WHAT WENT WRONG, AND WHY A WARNING WAS NOT ENOUGH ──────────────────────
//
// A CSV import wrote 1,277 wines whose `producer` was the empty string and
// whose producer name was run together with the cuvée inside `name`
// ("Benjamin Leroux Vosne-Romanée"). Identity resolution is producer-first,
// so not one of them could reach the canonical_wines spine — and everything
// downstream of identity (the corpus match, the picture, region, drink
// window) is therefore unreachable for them too. Migration 0137 recovered
// 956 producers by longest-word-prefix match against lwin_catalog; 321 rows,
// 23% of production's cellar, still carry a blank producer today. AGENTS.md
// § "two identity systems" is the full record.
//
// 0137 was a REPAIR, not a guard: re-importing the same CSV reproduces the
// defect exactly, and that has already happened on this checkout. The import
// path grew a `producerMissing` flag (row-validator.ts) and a preview panel
// that counts and warns — but nothing anybody must act on. A warning nobody
// must act on is not a guard.
//
// ── WHY THIS SHAPE, AND NOT THE ALTERNATIVES ───────────────────────────────
//
// REFUSE THE ROW was rejected. A blank producer is not malformed data: real
// Binwise / BevSpot / CellarTracker exports legitimately have no producer
// column at all, and the whole producer is sitting inside `name` exactly as
// the vendor wrote it. Rejecting those rows would reject the file — the one
// path a customer's entire cellar arrives through — to protect a data shape
// the operator may have no way to fix.
//
// RECOVER THE PRODUCER AT WRITE TIME (the technique 0137 used, implemented
// and measured in src/lib/wine-intelligence/producer-from-name.ts) was
// rejected as a DEFAULT. It would silently rewrite `producer` and `name` for
// rows the operator never inspected, on the one path a customer's cellar
// arrives through — and its own author measured the failure rate: at the
// one-word prefix floor, 38 of 250 negative-control rows recover a WRONG
// producer ('Canto Verde …' -> 'Canto'). Two words admits none, but drops
// legitimate one-word houses (Savart, Vietti, Bollinger) from 724 recoveries
// to 520. It is also one database round trip per distinct name, inside a
// confirm with a 60s maxDuration and a MAX_ROWS ceiling. A repair function
// an operator can run deliberately, with an audit table behind it, is the
// right home for that technique; a silent rewrite inside confirm is not.
//
// WHAT THIS IS: an explicit, SERVER-ENFORCED acknowledgement. The operator
// is told how many rows have no producer and what that costs them, and
// confirm refuses until they say yes. Nothing about a successful import
// CHANGES — the same rows, the same values, the same producer:"" reaching
// wines.producer. What changes is that it can no longer happen by accident,
// and — because the check lives here, on the server, rather than in the
// preview component — a UI regression that drops the panel cannot silently
// reopen the hole. It fails the import instead.
//
// ── THE COUNT IS THE ANCHOR ────────────────────────────────────────────────
//
// The acknowledgement carries the NUMBER the operator was shown, not a bare
// boolean, and the server requires it to be at least its own independently
// re-derived count. That is what makes it an acknowledgement OF THIS FILE
// rather than a constant any caller can hardcode: a client that always sends
// `1` is refused the moment a file has two blank-producer rows.
//
// The comparison is `>=`, deliberately, in the one direction that is safe.
// Confirm re-derives its preview WITH the operator's inline row fixes
// applied, so its count can legitimately be LOWER than the preview's (a fix
// that supplies a producer) — that must not be an error. It can only be
// HIGHER if the file changed meaning under the operator, which is exactly
// when they should look again. computePreviewCounts (preview-counts.ts)
// keeps the client's number tracking the same overrides, so the ordinary
// case never trips it.
//
// This is a data-quality gate, not a security boundary, and it is written to
// be honest about that: any client can send a number. What it guarantees is
// that no caller — a script, a future client, a regressed panel — imports
// blank producers WITHOUT SAYING SO. That is the property 0137's incident
// report asked for.
//
// NOT folded into content_sha256. The acknowledgement changes nothing about
// what gets written, so it must not change a confirm's content identity —
// doing so would make a re-acknowledged retry look like different content to
// the resume/dedup machinery (see confirmImportBatch's digest comment).

import type { PreviewRow } from "./preview-service";

export type MissingProducerAcknowledgementCheck =
  | { ok: true }
  | { ok: false; error: { code: string; message: string } };

/**
 * How many rows this import would write with no producer at all.
 *
 * Only VALID rows count: an error row is excluded from the import entirely,
 * so it can never reach wines.producer and there is nothing to acknowledge
 * about it. preview-service.ts's own summary calls this same function, so
 * the number the operator is shown and the number confirm enforces against
 * can never drift apart.
 */
export function countMissingProducerRows(rows: PreviewRow[]): number {
  return rows.filter((row) => row.rowState === "valid" && row.producerStatus === "missing").length;
}

/**
 * Gate a confirm on the operator having acknowledged its blank-producer
 * rows. `undefined` means the caller never sent an acknowledgement at all —
 * an older client, a script, or a UI that lost its panel — and is refused
 * whenever there is anything to acknowledge.
 */
export function checkMissingProducerAcknowledgement(
  acknowledgedMissingProducerRows: number | undefined,
  rows: PreviewRow[],
): MissingProducerAcknowledgementCheck {
  const missing = countMissingProducerRows(rows);
  if (missing === 0) return { ok: true };

  const cost =
    "A wine with no producer cannot be matched to the shared wine catalogue, so it will never gain a label photograph, a region, or a drink window.";

  if (acknowledgedMissingProducerRows === undefined) {
    return {
      ok: false,
      error: {
        code: "missing_producer_unacknowledged",
        message: `${missing} row${missing === 1 ? " has" : "s have"} no producer. ${cost} Confirm on the preview that you want to import ${missing === 1 ? "it" : "them"} anyway, or add a producer/winery column to your file.`,
      },
    };
  }

  if (acknowledgedMissingProducerRows < missing) {
    return {
      ok: false,
      error: {
        code: "missing_producer_acknowledgement_stale",
        message: `This import now has ${missing} row${missing === 1 ? "" : "s"} with no producer, but only ${acknowledgedMissingProducerRows} ${acknowledgedMissingProducerRows === 1 ? "was" : "were"} acknowledged. Review the preview again before importing.`,
      },
    };
  }

  return { ok: true };
}
