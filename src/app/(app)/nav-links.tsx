"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { LucideIcon } from "lucide-react";

interface NavLinksProps {
  tabs: ReadonlyArray<{ href: string; label: string; Icon: LucideIcon }>;
}

/** Desktop top nav links with aria-current for the active route. */
export function DesktopNavLinks({ tabs }: NavLinksProps) {
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
            className="rounded-sm px-md py-sm text-[14px] font-medium text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink"
          >
            {label}
          </Link>
        );
      })}
    </>
  );
}

/** Mobile bottom tab bar with aria-current for the active route. */
export function MobileNavLinks({ tabs }: NavLinksProps) {
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
            className="flex min-h-[64px] flex-col items-center justify-center gap-xs px-sm py-sm text-[11px] font-medium text-ink-muted active:bg-surface-muted"
          >
            <Icon className="h-6 w-6" strokeWidth={1.75} aria-hidden="true" />
            <span>{label}</span>
          </Link>
        );
      })}
    </>
  );
}
