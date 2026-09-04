"use client";

/**
 * The operational badges, each of which states its rule when opened.
 *
 * A client component for one reason: the rule is revealed on tap. A badge
 * that cannot say why it fired is a badge nobody trusts twice, and an
 * untrusted badge row is worse than none — it trains people to ignore the
 * page. Achromatic chips; the label carries the meaning.
 */
import { useState } from "react";
import type { Badge } from "@/domains/wine-profile/badges";
import { BasisLabel } from "@/lib/provenance/basis-label";
import type { Sourced } from "@/lib/provenance/sourced";

export function OperationalBadges({ badges }: { badges: Sourced<Badge[]> }) {
  const [open, setOpen] = useState<Badge["kind"] | null>(null);
  if (badges.value.length === 0) return null;

  const opened = badges.value.find((b) => b.kind === open) ?? null;

  return (
    <div className="mt-lg flex flex-col gap-sm">
      <ul className="flex flex-wrap gap-sm">
        {badges.value.map((badge) => {
          const isOpen = badge.kind === open;
          return (
            <li key={badge.kind}>
              <button
                type="button"
                aria-expanded={isOpen}
                aria-controls={`badge-rule-${badge.kind}`}
                onClick={() => setOpen(isOpen ? null : badge.kind)}
                className={`min-h-11 rounded-pill border px-md text-body-sm transition-colors ${
                  isOpen
                    ? "border-ink bg-ink text-canvas"
                    : "border-rule bg-surface text-ink-soft hover:border-ink"
                }`}
              >
                {badge.label}
              </button>
            </li>
          );
        })}
      </ul>
      {opened !== null && (
        <p id={`badge-rule-${opened.kind}`} className="text-body-sm text-ink-soft">
          {opened.rule}
        </p>
      )}
      <BasisLabel basis={badges.basis} />
    </div>
  );
}
