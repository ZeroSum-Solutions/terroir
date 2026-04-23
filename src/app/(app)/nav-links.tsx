"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  Grid2x2,
  ListOrdered,
  PowerOff,
  Scale,
  ScanLine,
  Wine,
} from "lucide-react";
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

const ALL_TABS: Tab[] = [
  { href: "/scanner", label: "Scanner", Icon: ScanLine },
  { href: "/wine-list", label: "Wine Lists", Icon: ListOrdered },
  { href: "/pour", label: "Pour", Icon: Wine },
  { href: "/availability", label: "Availability", Icon: PowerOff },
  {
    href: "/reconcile",
    label: "Reconcile",
    Icon: Scale,
    requires: ["owner", "manager"],
  },
  { href: "/dashboard", label: "Dashboard", Icon: BarChart3 },
  { href: "/cellar", label: "Cellar", Icon: Grid2x2 },
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
              "rounded-sm px-md py-sm text-[14px] font-medium transition-colors",
              active
                ? "bg-surface-muted text-ink"
                : "text-ink-muted hover:bg-surface-muted hover:text-ink",
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
 * Tailwind needing a grid-cols-N class at build time. With BND-038 we
 * can have 6 tabs (staff) or 7 (owner/manager).
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
                ? "border-t-2 border-accent bg-surface-muted text-accent"
                : "border-t-2 border-transparent text-ink-muted active:bg-surface-muted",
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
