"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, Grid2x2, ListOrdered, ScanLine } from "lucide-react";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/scanner", label: "Scanner", Icon: ScanLine },
  { href: "/wine-list", label: "Wine Lists", Icon: ListOrdered },
  { href: "/dashboard", label: "Dashboard", Icon: BarChart3 },
  { href: "/cellar", label: "Cellar", Icon: Grid2x2 },
] as const;

/** Desktop top nav links with aria-current for the active route. */
export function DesktopNavLinks() {
  const tabs = TABS;
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

/** Mobile bottom tab bar with aria-current for the active route. */
export function MobileNavLinks() {
  const tabs = TABS;
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
              "flex min-h-[64px] flex-col items-center justify-center gap-xs px-sm py-sm text-[11px] font-medium transition-colors",
              active
                ? "border-t-2 border-accent bg-surface-muted text-accent"
                : "border-t-2 border-transparent text-ink-muted active:bg-surface-muted",
            )}
          >
            <Icon className={cn("h-6 w-6", active && "text-accent")} strokeWidth={active ? 2 : 1.75} aria-hidden="true" />
            <span>{label}</span>
          </Link>
        );
      })}
    </>
  );
}
