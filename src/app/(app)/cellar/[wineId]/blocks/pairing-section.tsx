import { Section } from "@/components/detail-sections";

export function PairingSection({ pairings }: { pairings: string[] }) {
  return (
    <Section title="Food that goes well with this wine">
      <ul className="flex flex-wrap gap-sm">
        {pairings.map((pairing) => (
          <li
            key={pairing}
            className="rounded-pill border border-rule bg-surface px-md py-xs text-body-sm text-ink-soft"
          >
            {pairing}
          </li>
        ))}
      </ul>
    </Section>
  );
}
