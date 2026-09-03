import { Fact, Section } from "@/components/detail-sections";
import type { WineRow } from "./types";

export function CellarSection({
  wine,
  bottleCount,
  locations,
}: {
  wine: WineRow;
  bottleCount: number;
  locations: string[];
}) {
  return (
    <Section title="In your cellar">
      <dl className="card-surface grid gap-0 rounded-card px-lg py-xs sm:grid-cols-2 sm:gap-x-2xl">
        <Fact
          label="Bottles on hand"
          value={bottleCount === 0 ? "None" : `${bottleCount}`}
        />
        <Fact label="Stored" value={locations.join(", ") || null} />
        <Fact
          label="Retail range"
          value={
            wine.retail_min != null && wine.retail_max != null
              ? `$${wine.retail_min} – $${wine.retail_max}`
              : null
          }
        />
        <Fact
          label="Retail median"
          value={
            wine.retail_median != null
              ? `$${wine.retail_median}` +
                (wine.retail_retailer_count
                  ? ` from ${wine.retail_retailer_count} retailers`
                  : "")
              : null
          }
        />
      </dl>
    </Section>
  );
}
