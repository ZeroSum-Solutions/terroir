"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, ListOrdered, Map, ScanLine, Wine } from "lucide-react";
import { cn } from "@/lib/utils";

type Role = "owner" | "manager" | "staff";

type Tab = {
  href: string;
  label: string;
  Icon: React.ComponentType<{
    className?: string;
    strokeWidth?: number;
    "aria-hidden"?: boolean;
  }>;
  // Undefined = all roles. Otherwise only the listed roles see the tab.
  requires?: Role[];
};

// 5-tab IA (Atlas center tab, D5) — was the 4-tab set per
// .council/specs/2026-04-24-ux-ia-redesign.md (itself a consolidation of
// 7: Scanner / Wine Lists / Pour / Availability / Reconcile / Dashboard /
// Cellar — bloated past the prototype's 3-tab intent and truncated on
// 390px phones at ~55px per tab). Pour + Availability + Reconcile + the
// original bin grid all live inside /cellar (single-screen with rich
// row-actions). Atlas joins as a fifth, center tab — 390px/5 lands at
// ~78px per tab, still comfortably above the 55px truncation floor the
// 7->4 collapse was fixing. Default landing per role is handled at
// src/app/page.tsx.
const ALL_TABS: Tab[] = [
  { href: "/scan", label: "Scan", Icon: ScanLine },
  { href: "/cellar", label: "Cellar", Icon: Wine },
  { href: "/atlas", label: "Atlas", Icon: Map },
  { href: "/lists", label: "Lists", Icon: ListOrdered },
  { href: "/insights", label: "Insights", Icon: BarChart3 },
];

function visibleTabs(role: Role): Tab[] {
  return ALL_TABS.filter((t) => !t.requires || t.requires.includes(role));
}

/** Desktop top nav links with aria-current for the active route. */
export function DesktopNavLinks({ role }: { role: Role }) {
  const tabs = visibleTabs(role);
  const pathname = usePathname();
  return (
    <>
      {tabs.map(({ href, label }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex min-h-11 min-w-11 items-center justify-center py-sm text-[13px] font-normal underline-offset-4 transition-colors",
              active
                ? "text-accent underline decoration-1"
                : "text-ink-soft no-underline hover:text-accent",
            )}
          >
            {label}
          </Link>
        );
      })}
    </>
  );
}

/**
 * Mobile bottom tab bar. Uses flex so N tabs distribute evenly without
 * Tailwind needing a grid-cols-N class at build time. v5 IA collapsed
 * the previous 7-tab nav to 4, then D5 added Atlas as a fifth, center
 * tab — touch targets at ~78px each on a 390px phone (was 55px and
 * truncating at 7 tabs).
 */
export function MobileNavLinks({ role }: { role: Role }) {
  const tabs = visibleTabs(role);
  const pathname = usePathname();
  return (
    <>
      {tabs.map(({ href, label, Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-h-[64px] flex-1 flex-col items-center justify-center gap-xs px-2xs py-sm text-[11px] font-medium transition-colors",
              active
                ? "border-t-2 border-accent text-accent"
                : "border-t-2 border-transparent text-grey active:bg-bridge-surface",
            )}
          >
            <Icon
              className={cn("h-5 w-5", active && "text-accent")}
              strokeWidth={active ? 2 : 1.75}
              aria-hidden
            />
            <span className="truncate">{label}</span>
          </Link>
        );
      })}
    </>
  );
}
