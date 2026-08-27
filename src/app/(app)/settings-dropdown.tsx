"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Archive, DollarSign, LogOut, Settings, Upload, Users } from "lucide-react";
import { ThemeToggle } from "./theme-toggle";

export function SettingsDropdown() {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemsRef = useRef<(HTMLElement | null)[]>([]);

  const close = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      const items = itemsRef.current.filter(Boolean) as HTMLElement[];
      if (!items.length) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = activeIndex < items.length - 1 ? activeIndex + 1 : 0;
        setActiveIndex(next);
        items[next]?.focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const prev = activeIndex > 0 ? activeIndex - 1 : items.length - 1;
        setActiveIndex(prev);
        items[prev]?.focus();
      }
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, close, activeIndex]);

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Settings"
        aria-expanded={open}
        aria-haspopup="true"
        className="flex h-11 w-11 items-center justify-center rounded-pill text-grey transition-colors hover:bg-bridge-surface hover:text-ink focus-visible:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent md:h-auto md:w-auto md:border md:border-beige-deep md:bg-surface md:px-md md:py-sm"
      >
        <Settings className="h-5 w-5 md:h-4 md:w-4" strokeWidth={1.75} aria-hidden="true" />
      </button>

      {/* Mobile scrim — the menu floated over a busy screen of chips and
          CTAs with no separation (Kimi audit 2026-08-26). Desktop keeps
          the lightweight dropdown convention. */}
      {open && (
        <div
          className="fixed inset-0 z-20 bg-scrim md:hidden"
          aria-hidden="true"
          onClick={close}
        />
      )}
      {open && (
        <div className="absolute right-0 top-full z-30 mt-xs w-[180px] rounded-card card-surface" role="menu">
          <div className="flex flex-col py-xs">
            <Link
              ref={(el) => { itemsRef.current[0] = el; }}
              href="/price-comparison"
              onClick={close}
              role="menuitem"
              tabIndex={-1}
              className="flex min-h-11 items-center gap-sm px-md py-sm text-[14px] text-ink transition-colors hover:bg-bridge-surface focus-visible:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <DollarSign className="h-4 w-4 text-ink-muted" strokeWidth={1.75} aria-hidden="true" />
              Pricing
            </Link>
            <Link
              ref={(el) => { itemsRef.current[1] = el; }}
              href="/bins"
              onClick={close}
              role="menuitem"
              tabIndex={-1}
              className="flex min-h-11 items-center gap-sm px-md py-sm text-[14px] text-ink transition-colors hover:bg-bridge-surface focus-visible:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <Archive className="h-4 w-4 text-ink-muted" strokeWidth={1.75} aria-hidden="true" />
              Bins
            </Link>
            {/* Reconcile lives on the dashboard as a live-count CTA; the
                duplicate menu entry (without the count) is gone
                (Kimi audit 2026-08-26). */}
            <Link
              ref={(el) => { itemsRef.current[2] = el; }}
              href="/team"
              onClick={close}
              role="menuitem"
              tabIndex={-1}
              className="flex min-h-11 items-center gap-sm px-md py-sm text-[14px] text-ink transition-colors hover:bg-bridge-surface focus-visible:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <Users className="h-4 w-4 text-ink-muted" strokeWidth={1.75} aria-hidden="true" />
              Team
            </Link>
            <Link
              ref={(el) => { itemsRef.current[3] = el; }}
              href="/import"
              onClick={close}
              role="menuitem"
              tabIndex={-1}
              className="flex min-h-11 items-center gap-sm px-md py-sm text-[14px] text-ink transition-colors hover:bg-bridge-surface focus-visible:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <Upload className="h-4 w-4 text-ink-muted" strokeWidth={1.75} aria-hidden="true" />
              Import
            </Link>
            <div className="mx-md my-xs border-t border-hairline" role="separator" />
            <ThemeToggle />
            <div className="mx-md my-xs border-t border-hairline" role="separator" />
            <form action="/auth/signout" method="post">
              <button
                ref={(el) => { itemsRef.current[4] = el; }}
                type="submit"
                role="menuitem"
                tabIndex={-1}
                className="flex min-h-11 w-full items-center gap-sm px-md py-sm text-[14px] text-ink transition-colors hover:bg-bridge-surface focus-visible:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                <LogOut className="h-4 w-4 text-ink-muted" strokeWidth={1.75} aria-hidden="true" />
                Sign out
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
