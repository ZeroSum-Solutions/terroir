import { ExternalLink } from "lucide-react";
import { Fact, Section } from "@/components/detail-sections";
import type { ResolvedWineFacts } from "@/lib/wine-intelligence/wine-reference-facts";
import type { XWinesProfile } from "@/lib/wine-intelligence/xwines-profile";
import type { WineRow } from "./types";

export function FactsSection({
  wine,
  profile,
  facts,
}: {
  wine: WineRow;
  profile: XWinesProfile | null;
  facts: ResolvedWineFacts;
}) {
  return (
    <Section title="Facts about the wine">
      <dl className="card-surface grid gap-0 rounded-card px-lg py-xs sm:grid-cols-2 sm:gap-x-2xl">
        <Fact label="Producer" value={wine.producer} />
        <Fact label="Grapes" value={profile?.grapes.join(", ") || facts.varietal} />
        <Fact
          label="Region"
          value={[facts.region, facts.country].filter(Boolean).join(", ") || null}
        />
        <Fact label="Style" value={profile?.elaborate ?? profile?.type ?? null} />
        <Fact
          label="Alcohol"
          value={profile?.abv != null ? `${profile.abv}%` : null}
        />
        <Fact
          label="Bottle"
          value={wine.size_ml != null ? `${wine.size_ml} ml` : null}
        />
        {profile?.website && (
          <Fact
            label="Winery"
            value={
              <a
                href={profile.website}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-xs text-accent hover:underline"
              >
                {profile.matchedWinery ?? wine.producer}
                <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
              </a>
            }
          />
        )}
      </dl>
    </Section>
  );
}
