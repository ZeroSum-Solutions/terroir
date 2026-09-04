/**
 * The drink window, drawn on the existing timeline, with where it came from
 * underneath. Only a sourced or house-set window ever reaches this block —
 * the reference resolver returns null for anything else, so there is no
 * "estimated" state to draw.
 */
import { DrinkWindowTimeline } from "@/components/drink-window-timeline";
import { Section } from "@/components/detail-sections";
import type { DrinkWindow } from "@/domains/wine-profile/resolve-reference-profile";
import { BasisLabel } from "@/lib/provenance/basis-label";
import type { Sourced } from "@/lib/provenance/sourced";

export function DrinkWindowBlock({
  window,
  currentYear,
}: {
  window: Sourced<DrinkWindow>;
  currentYear: number;
}) {
  return (
    <Section title="Drink window">
      <div className="card-surface rounded-card px-lg py-md" data-testid="drink-window-block">
        <DrinkWindowTimeline
          start={window.value.start}
          end={window.value.end}
          currentYear={currentYear}
          size="full"
        />
        <p className="mt-md">
          <span className="text-body-sm text-ink">
            {window.value.start}–{window.value.end}.{" "}
          </span>
          <BasisLabel basis={window.basis} />
        </p>
      </div>
    </Section>
  );
}
