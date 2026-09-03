import type { Basis } from "./sourced";

/**
 * The one place a Basis becomes a sentence. Every number on the wine page
 * renders one of these beside it.
 *
 * The switch is exhaustive by way of the `never` assignment at the end, so
 * adding a sixth Basis kind is a compile error here rather than a number that
 * quietly appears with nothing under it.
 */
export function BasisLabel({ basis }: { basis: Basis }) {
  return (
    <span className="text-body-sm text-grey">{describe(basis)}</span>
  );
}

function describe(basis: Basis) {
  switch (basis.kind) {
    case "house":
      return (
        <>
          Across {basis.notes} house {basis.notes === 1 ? "note" : "notes"}
        </>
      );
    case "sourced":
      return (
        <>
          Per{" "}
          <a
            href={basis.url}
            target="_blank"
            rel="noreferrer noopener"
            className="text-accent hover:underline"
          >
            {basis.name}
          </a>
          , read {formatDate(basis.asOf)}
        </>
      );
    case "corpus":
      return <>From the {basis.name} reference corpus</>;
    case "override":
      return (
        <>
          Set by the house — {basis.by}, {formatDate(basis.at)}
        </>
      );
    case "measured":
      return <>From your own records, {formatDate(basis.asOf)}</>;
    default: {
      // Exhaustiveness guard. If this line stops compiling, a Basis kind was
      // added without a sentence for it — write the sentence, do not widen
      // this type.
      const exhaustive: never = basis;
      return exhaustive;
    }
  }
}

/**
 * Dates are spelled out rather than shown as 2026-08-14. A sourced number's
 * age is the thing a reader is actually judging — "read 14 August 2026" tells
 * them whether to trust it; an ISO string reads as machine output and gets
 * skipped.
 */
function formatDate(iso: string) {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
