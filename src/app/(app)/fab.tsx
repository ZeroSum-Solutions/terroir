"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Plus, PowerOff, ScanLine, Wine } from "lucide-react";
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
 * Speed-dial pattern: tap "+" → 3 working actions reveal vertically with a
 * staggered fade/slide. Tap any action to navigate. Tap the ×
 * (rotated +) or backdrop to close.
 */

type Action = {
  label: string;
  href: string;
  Icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
};

const ACTIONS: Action[] = [
  { label: "Scan invoice", href: "/scan", Icon: ScanLine },
  { label: "Pour", href: "/cellar?mode=pour", Icon: Wine },
  { label: "86 a wine", href: "/cellar?mode=eightysix", Icon: PowerOff },
];

// Routes where the FAB is hidden — pages that are themselves a
// primary-action surface or that don't need it. /atlas: the map's own
// tap targets (and the region bottom sheet) sit in the same bottom-right
// zone the FAB floats in — none of its actions (Scan/Pour/86) are Atlas
// tasks anyway.
const HIDE_ON: ReadonlyArray<string> = ["/scan", "/login", "/atlas"];

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
      className="pointer-events-none fixed inset-0 z-[var(--z-chrome)] md:hidden"
      aria-hidden={false}
    >
      {/* Trigger button. */}
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={open ? "Close actions" : "Open actions"}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "pointer-events-auto absolute right-md grid h-14 w-14 place-items-center rounded-pill bg-primary text-seal-ink transition-transform duration-200",
          "hover:bg-primary-hover active:scale-95 focus-ring",
          open && "rotate-45",
        )}
        style={{ bottom: "calc(env(safe-area-inset-bottom) + 80px)" }}
      >
        {/* Single icon that rotates 45° to become close. Avoids icon
            swap flicker. */}
        <Plus className="h-6 w-6" strokeWidth={2.25} aria-hidden />
      </button>

      {/* Action stack — fades+slides in. It follows the trigger in DOM
          order so forward Tab enters the open menu. When closed, `inert`
          removes the menu from the tab order and accessibility tree so
          keyboard and screen-reader users can't reach hidden actions
          through the visual cloak (opacity-0 alone leaves them focusable). */}
      <div
        className={cn(
          "pointer-events-none absolute right-md flex flex-col-reverse items-end gap-sm transition-opacity",
          open ? "opacity-100" : "opacity-0",
        )}
        style={{ bottom: "calc(env(safe-area-inset-bottom) + 152px)" }}
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
              setOpen(false);
              router.push(action.href);
            }}
          />
        ))}
      </div>
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
  const { label, Icon } = action;
  const transitionDelay = visible ? `${staggerIndex * 40}ms` : "0ms";

  const inner = (
    <span
      className={cn(
        "glass flex items-center gap-sm rounded-pill px-md py-sm text-[13px] font-medium transition-all duration-200",
        visible
          ? "translate-y-0 opacity-100"
          : "pointer-events-none translate-y-2 opacity-0",
      )}
      style={{ transitionDelay }}
    >
      <span className="text-[12px] uppercase tracking-[0.06em] text-grey">
        {label}
      </span>
      <span className="grid h-9 w-9 place-items-center rounded-pill bg-blush-wash text-accent">
        <Icon className="h-4 w-4" strokeWidth={2} />
      </span>
    </span>
  );

  return (
    <Link
      href={action.href}
      onClick={onActivate}
      aria-label={label}
      role="menuitem"
      className="pointer-events-auto inline-flex rounded-pill focus-ring"
    >
      {inner}
    </Link>
  );
}
