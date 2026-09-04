/**
 * Community rating by vintage, from the corpus, with the corpus named
 * underneath. Renders nothing for a single vintage: there is nothing to
 * compare, and a one-row table reads as a broken query.
 */
import { Star } from "lucide-react";
import { Section } from "@/components/detail-sections";
import { BasisLabel } from "@/lib/provenance/basis-label";
import type { Sourced } from "@/lib/provenance/sourced";
import type { VintageRating } from "@/lib/wine-intelligence/xwines-profile";

export function VintageUnavailableSection() {
  return (
    <Section title="Compare vintages">
      <p className="text-body-sm text-grey">
        Per-vintage ratings couldn&rsquo;t be read just now. This is a
        problem at our end, not a wine without ratings — try again
        shortly.
      </p>
    </Section>
  );
}

export function VintageRail({
  rows,
  wineVintage,
  matchedName,
}: {
  rows: Sourced<VintageRating[]>;
  wineVintage: number | null;
  matchedName: string | null;
}) {
  if (rows.value.length < 2) return null;

  return (
    <Section title="Compare vintages">
      <table className="w-full border-collapse text-body-sm">
        <caption className="sr-only">
          Community rating by vintage for {matchedName}
        </caption>
        <thead>
          <tr className="border-b border-rule text-caption uppercase text-grey">
            <th scope="col" className="py-sm text-left font-medium">Vintage</th>
            <th scope="col" className="py-sm text-left font-medium">Rating</th>
            <th scope="col" className="py-sm text-right font-medium">Ratings</th>
          </tr>
        </thead>
        <tbody>
          {rows.value.map((row) => {
            const isThisBottle = row.vintage === wineVintage;
            return (
              <tr
                key={row.vintage}
                className={`border-b border-rule ${isThisBottle ? "bg-risk-wash" : ""}`}
              >
                <th
                  scope="row"
                  className={`py-sm text-left tabular text-ledger ${isThisBottle ? "text-mark" : "text-ink"}`}
                >
                  {row.vintage}
                  {isThisBottle && (
                    <span className="ml-sm text-caption uppercase">Yours</span>
                  )}
                </th>
                <td className="py-sm">
                  <span className="flex items-center gap-xs">
                    <Star aria-hidden="true" className="h-3.5 w-3.5 fill-mark text-mark" />
                    <span className="tabular text-ledger text-ink">{row.ratingAvg.toFixed(1)}</span>
                  </span>
                </td>
                <td className="py-sm text-right tabular text-ledger text-grey">
                  {row.ratingCount.toLocaleString()}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-md">
        <BasisLabel basis={rows.basis} />
      </p>
    </Section>
  );
}
