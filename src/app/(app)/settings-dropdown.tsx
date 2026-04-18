"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { DollarSign, LogOut, Settings, Users } from "lucide-react";

export function SettingsDropdown() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open, close]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Settings"
        aria-expanded={open}
        className="flex h-10 w-10 items-center justify-center rounded-sm text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink md:h-auto md:w-auto md:border md:border-border-strong md:bg-white md:px-md md:py-sm"
      >
        <Settings className="h-5 w-5 md:h-4 md:w-4" strokeWidth={1.75} />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-xs w-[180px] rounded-md border border-border bg-surface shadow-lg">
          <nav className="flex flex-col py-xs">
            <Link
              href="/price-comparison"
              onClick={close}
              className="flex items-center gap-sm px-md py-sm text-[14px] text-ink transition-colors hover:bg-surface-muted"
            >
              <DollarSign className="h-4 w-4 text-ink-muted" strokeWidth={1.75} />
              Pricing
            </Link>
            <Link
              href="/team"
              onClick={close}
              className="flex items-center gap-sm px-md py-sm text-[14px] text-ink transition-colors hover:bg-surface-muted"
            >
              <Users className="h-4 w-4 text-ink-muted" strokeWidth={1.75} />
              Team
            </Link>
            <div className="mx-md my-xs border-t border-border" />
            <form action="/auth/signout" method="post">
              <button
                type="submit"
                className="flex w-full items-center gap-sm px-md py-sm text-[14px] text-ink transition-colors hover:bg-surface-muted"
              >
                <LogOut className="h-4 w-4 text-ink-muted" strokeWidth={1.75} />
                Sign out
              </button>
            </form>
          </nav>
        </div>
      )}
    </div>
  );
}
