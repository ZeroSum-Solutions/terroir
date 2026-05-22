"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Mic, Plus, PowerOff, ScanLine, Wine } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Floating Action Button — mobile-only primary actions surface.
 *
 * Per .council/specs/2026-04-24-ux-ia-redesign.md §5. The 7→4 tab
 * collapse freed bottom-nav real estate that used to host primary
 * action verbs (Pour, 86, Reconcile). Those move into Cellar
 * (Phase 2) and become FAB-triggered on mobile so a sommelier
 * mid-service can tap once to act, not navigate to a tab first.
 *
 * Visibility:
 *   • Mobile only (md:hidden — desktop has inline buttons in Cellar)
 *   • Hidden on /scan (the page IS already a primary-action surface)
 *   • Hidden on /login and pre-auth states
 *
 * Speed-dial pattern: tap "+" → 4 actions reveal vertically with a
 * staggered fade/slide. Tap any action to navigate. Tap the ×
 * (rotated +) or backdrop to close.
 *
 * Voice action is currently a stub. v2 lands the Whisper integration
 * per the spec's magical-UX promotion (wine-food pairing + similar-
 * substitutes ship in v1.5; voice/camera in v2). The disabled state
 * with "Coming soon" tooltip seeds the affordance now so users see
 * the destination.
 */

type Action = {
  label: string;
  href?: string;
  Icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  disabled?: boolean;
  disabledReason?: string;
};

const ACTIONS: Action[] = [
  { label: "Scan invoice", href: "/scan", Icon: ScanLine },
  { label: "Pour", href: "/cellar?mode=pour", Icon: Wine },
  { label: "86 a wine", href: "/cellar?mode=eightysix", Icon: PowerOff },
  {
    label: "Voice command",
    Icon: Mic,
    disabled: true,
    disabledReason: "Coming in v2",
  },
];

// Routes where the FAB is hidden — pages that are themselves a
// primary-action surface or that don't need it.
const HIDE_ON: ReadonlyArray<string> = ["/scan", "/login"];

function shouldHide(pathname: string): boolean {
  return HIDE_ON.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

// The exported wrapper keys on pathname so the FAB remounts on every
// navigation. That cleanly resets the open/closed state without
// calling setState from an effect (which would trip the
// react-hooks/set-state-in-effect lint rule).
export function Fab() {
  const pathname = usePathname();
  if (shouldHide(pathname)) return null;
  return <FabInner key={pathname} />;
}

function FabInner() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on Escape or click outside.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      const root = containerRef.current;
      if (root && !root.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  return (
    <div
      ref={containerRef}
      className="pointer-events-none fixed inset-x-0 bottom-0 z-30 md:hidden"
      style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 80px)" }}
      aria-hidden={false}
    >
      {/* Action stack — fades+slides in. When closed, `inert` removes
          the menu from the tab order and accessibility tree so keyboard
          and screen-reader users can't reach the hidden actions through
          the visual cloak (opacity-0 alone leaves them focusable). */}
      <div
        className={cn(
          "pointer-events-none absolute right-md flex flex-col-reverse items-end gap-sm transition-opacity",
          open ? "opacity-100" : "opacity-0",
        )}
        style={{ bottom: "72px" }}
        role="menu"
        aria-label="Primary actions"
        aria-hidden={!open}
        inert={!open}
      >
        {ACTIONS.map((action, i) => (
          <ActionPill
            key={action.label}
            action={action}
            visible={open}
            staggerIndex={i}
            onActivate={() => {
              if (action.disabled) return;
              setOpen(false);
              if (action.href) router.push(action.href);
            }}
          />
        ))}
      </div>

      {/* Trigger button. */}
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={open ? "Close actions" : "Open actions"}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "pointer-events-auto absolute bottom-0 right-md grid h-14 w-14 place-items-center rounded-full bg-accent text-white shadow-md transition-transform duration-200",
          "hover:bg-accent-hover active:scale-95",
          open && "rotate-45",
        )}
      >
        {/* Single icon that rotates 45° to become close. Avoids icon
            swap flicker. */}
        <Plus className="h-6 w-6" strokeWidth={2.25} aria-hidden />
      </button>
    </div>
  );
}

function ActionPill({
  action,
  visible,
  staggerIndex,
  onActivate,
}: {
  action: Action;
  visible: boolean;
  staggerIndex: number;
  onActivate: () => void;
}) {
  const { label, Icon, disabled, disabledReason } = action;
  const transitionDelay = visible ? `${staggerIndex * 40}ms` : "0ms";

  const inner = (
    <span
      className={cn(
        "flex items-center gap-sm rounded-full bg-surface px-md py-sm text-[13px] font-medium shadow-md ring-1 ring-border-strong transition-all duration-200",
        visible
          ? "translate-y-0 opacity-100"
          : "pointer-events-none translate-y-2 opacity-0",
        disabled && "opacity-60",
      )}
      style={{ transitionDelay }}
    >
      <span className="text-[12px] uppercase tracking-[0.06em] text-ink-muted">
        {label}
      </span>
      <span
        className={cn(
          "grid h-9 w-9 place-items-center rounded-full",
          disabled ? "bg-surface-sunken text-ink-subtle" : "bg-accent-soft text-accent",
        )}
      >
        <Icon className="h-4 w-4" strokeWidth={2} />
      </span>
    </span>
  );

  if (disabled) {
    return (
      <button
        type="button"
        disabled
        title={disabledReason}
        aria-label={`${label} (${disabledReason ?? "unavailable"})`}
        className="pointer-events-auto cursor-not-allowed"
      >
        {inner}
      </button>
    );
  }

  if (action.href) {
    return (
      <Link
        href={action.href}
        onClick={onActivate}
        aria-label={label}
        role="menuitem"
        className="pointer-events-auto"
      >
        {inner}
      </Link>
    );
  }

  return (
    <button
      type="button"
      onClick={onActivate}
      aria-label={label}
      role="menuitem"
      className="pointer-events-auto"
    >
      {inner}
    </button>
  );
}
