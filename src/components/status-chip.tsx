import { cn } from "@/lib/utils";

/**
 * Wax & Counter — the one status language (DESIGN.md amendment,
 * 2026-08-26). Status encodes as a single urgency scale instead of the
 * retired sage/powder/amber hue families:
 *
 *   muted     — no signal (out of scope, empty)
 *   neutral   — routine ledger stamp: quiet bordered pill, no fill
 *   optimal   — the gold marker: a wine at its best
 *   attention — first burgundy step (gold at night): act soon
 *   urgent    — the filled wax seal: act now / money at risk
 *
 * Burgundy carries urgency by day; in the dark cellar the same tones read
 * in candle gold because `accent` swaps per theme. The filled seal keeps
 * a faint inner impression ring — the stamp pressed into wax.
 */
export type WaxTone = "muted" | "neutral" | "optimal" | "attention" | "urgent";

export function StatusChip({
  tone,
  children,
  className,
}: {
  tone: WaxTone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      data-tone={tone}
      className={cn(
        "inline-flex items-center gap-2xs whitespace-nowrap rounded-pill border px-sm py-2xs text-[10px] font-medium uppercase tracking-[0.13em]",
        tone === "muted" && "border-transparent bg-bridge-surface text-grey",
        tone === "neutral" && "border-edge bg-transparent text-ink-soft",
        tone === "optimal" && "border-gold/40 bg-gold/10 text-gold",
        tone === "attention" && "border-accent/40 bg-accent/10 text-accent",
        tone === "urgent" &&
          "border-primary bg-primary text-seal-ink shadow-[inset_0_0_0_2px_var(--t-primary),inset_0_0_0_3px_rgba(246,240,227,0.35)]",
        className,
      )}
    >
      {children}
    </span>
  );
}
