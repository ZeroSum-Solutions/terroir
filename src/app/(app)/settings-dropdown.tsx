"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Archive, ClipboardCheck, DollarSign, LogOut, Settings, Users } from "lucide-react";

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
        className="flex h-10 w-10 items-center justify-center rounded-sm text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink md:h-auto md:w-auto md:border md:border-border-strong md:bg-white md:px-md md:py-sm"
      >
        <Settings className="h-5 w-5 md:h-4 md:w-4" strokeWidth={1.75} aria-hidden="true" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-xs w-[180px] rounded-md border border-border bg-surface shadow-lg" role="menu">
          <div className="flex flex-col py-xs">
            <Link
              ref={(el) => { itemsRef.current[0] = el; }}
              href="/price-comparison"
              onClick={close}
              role="menuitem"
              tabIndex={-1}
              className="flex items-center gap-sm px-md py-sm text-[14px] text-ink transition-colors hover:bg-surface-muted"
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
              className="flex items-center gap-sm px-md py-sm text-[14px] text-ink transition-colors hover:bg-surface-muted"
            >
              <Archive className="h-4 w-4 text-ink-muted" strokeWidth={1.75} aria-hidden="true" />
              Bins
            </Link>
            <Link
              ref={(el) => { itemsRef.current[2] = el; }}
              href="/reconcile-queue"
              onClick={close}
              role="menuitem"
              tabIndex={-1}
              className="flex min-h-11 items-center gap-sm px-md py-sm text-[14px] text-ink transition-colors hover:bg-surface-muted"
            >
              <ClipboardCheck className="h-4 w-4 text-ink-muted" strokeWidth={1.75} aria-hidden="true" />
              Reconcile
            </Link>
            <Link
              ref={(el) => { itemsRef.current[3] = el; }}
              href="/team"
              onClick={close}
              role="menuitem"
              tabIndex={-1}
              className="flex items-center gap-sm px-md py-sm text-[14px] text-ink transition-colors hover:bg-surface-muted"
            >
              <Users className="h-4 w-4 text-ink-muted" strokeWidth={1.75} aria-hidden="true" />
              Team
            </Link>
            <div className="mx-md my-xs border-t border-border" role="separator" />
            <form action="/auth/signout" method="post">
              <button
                ref={(el) => { itemsRef.current[4] = el; }}
                type="submit"
                role="menuitem"
                tabIndex={-1}
                className="flex w-full items-center gap-sm px-md py-sm text-[14px] text-ink transition-colors hover:bg-surface-muted"
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
