import { Star } from "lucide-react";
import { Section } from "@/components/detail-sections";
import type { VintageRating, XWinesProfile } from "@/lib/wine-intelligence/xwines-profile";

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

export function VintageSection({
  vintageRatings,
  profile,
  wineVintage,
}: {
  vintageRatings: VintageRating[];
  profile: XWinesProfile | null;
  wineVintage: number | null;
}) {
  return (
    <Section title="Compare vintages">
      <table className="w-full border-collapse text-body-sm">
        <caption className="sr-only">
          Community rating by vintage for {profile?.matchedName}
        </caption>
        <thead>
          <tr className="border-b border-rule text-caption uppercase text-grey">
            <th scope="col" className="py-sm text-left font-medium">Vintage</th>
            <th scope="col" className="py-sm text-left font-medium">Rating</th>
            <th scope="col" className="py-sm text-right font-medium">Ratings</th>
          </tr>
        </thead>
        <tbody>
          {vintageRatings.map((row) => {
            const isThisBottle = row.vintage === wineVintage;
            return (
              <tr
                key={row.vintage}
                className={`border-b border-rule ${isThisBottle ? "bg-risk-wash" : ""}`}
              >
                <th
                  scope="row"
                  className={`py-sm text-left font-mono text-ledger ${isThisBottle ? "text-mark" : "text-ink"}`}
                >
                  {row.vintage}
                  {isThisBottle && (
                    <span className="ml-sm text-caption uppercase">Yours</span>
                  )}
                </th>
                <td className="py-sm">
                  <Stars value={row.ratingAvg} />
                </td>
                <td className="py-sm text-right font-mono text-ledger text-grey">
                  {row.ratingCount.toLocaleString()}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Section>
  );
}

function Stars({ value }: { value: number }) {
  return (
    <span className="flex items-center gap-xs">
      <Star aria-hidden="true" className="h-3.5 w-3.5 fill-mark text-mark" />
      <span className="font-mono text-ledger text-ink">{value.toFixed(1)}</span>
    </span>
  );
}
