"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * GLOBAL-01's escape valve: the control that replaces controls.
 *
 * Devin's rule — "if you cannot fit all the buttons horizontally in one frame,
 * then there are too many buttons" — has exactly two honest answers when a row
 * does not fit: delete a control, or demote it. Deleting the only route to
 * /cellar/config or to a CSV export is not an option, so they demote here: one
 * 44px trigger standing in for N actions, which costs the row one control
 * instead of N.
 *
 * Keyboard and focus behaviour follow src/app/(app)/settings-dropdown.tsx,
 * which is the pattern this repo already ships: Escape closes and returns
 * focus to the trigger, Arrow keys walk the items, a click outside dismisses,
 * and the phone gets a scrim because the menu otherwise floats over a busy
 * screen with no separation.
 */
export type OverflowMenuItem = {
  /** Stable key AND the accessible label. */
  label: string;
  Icon?: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  /** A link item. Mutually exclusive with `onSelect`. */
  href?: string;
  /** An action item. Mutually exclusive with `href`. */
  onSelect?: () => void;
  /** `<a download>` — the value becomes the suggested filename when a string. */
  download?: string | boolean;
  /** Opens in a new tab. */
  external?: boolean;
  disabled?: boolean;
  /**
   * Responsive demotion. An item carrying `sm:hidden` is in the menu only on
   * the widths where the row cannot afford it as a pill; above that breakpoint
   * the row shows it directly and the menu entry disappears, so the action is
   * never offered twice in the same frame.
   */
  className?: string;
};

export function OverflowMenu({
  label,
  items,
  className,
}: {
  /** Accessible name for the trigger, e.g. "More cellar actions". */
  label: string;
  items: OverflowMenuItem[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemsRef = useRef<(HTMLElement | null)[]>([]);

  const close = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    function handleClick(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
        setActiveIndex(-1);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      // Only the items the current width actually shows are navigable; a
      // `sm:hidden` entry is display:none on desktop and must not take focus.
      const nodes = itemsRef.current.filter(
        (node): node is HTMLElement => node !== null && node.offsetParent !== null,
      );
      if (nodes.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        const next = activeIndex < nodes.length - 1 ? activeIndex + 1 : 0;
        setActiveIndex(next);
        nodes[next]?.focus();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        const prev = activeIndex > 0 ? activeIndex - 1 : nodes.length - 1;
        setActiveIndex(prev);
        nodes[prev]?.focus();
      }
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, close, activeIndex]);

  if (items.length === 0) return null;

  const itemClassName =
    "flex min-h-11 w-full items-center gap-sm px-md py-sm text-left text-body-sm text-ink transition-colors hover:bg-wash focus-ring disabled:opacity-50";

  return (
    <div ref={containerRef} className={cn("relative shrink-0", className)}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex h-11 w-11 items-center justify-center rounded-pill border border-edge bg-surface text-ink-soft transition-colors hover:bg-wash focus-ring"
      >
        <MoreHorizontal className="h-4 w-4" strokeWidth={1.75} aria-hidden />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[var(--z-overlay)] bg-scrim md:hidden"
          aria-hidden="true"
          onClick={() => {
            setOpen(false);
            setActiveIndex(-1);
          }}
        />
      )}
      {open && (
        <div
          role="menu"
          aria-label={label}
          className="absolute right-0 top-full z-[var(--z-overlay)] mt-xs flex w-[240px] flex-col py-xs rounded-card card-surface"
        >
          {items.map((item, index) => {
            const content = (
              <>
                {item.Icon && (
                  <item.Icon className="h-4 w-4 text-grey" strokeWidth={1.75} />
                )}
                <span className="truncate">{item.label}</span>
              </>
            );
            if (item.href) {
              return (
                // A plain anchor, not next/link: these are downloads and
                // new-tab print/preview routes, which a client-side
                // navigation would swallow.
                <a
                  key={item.label}
                  ref={(node) => {
                    itemsRef.current[index] = node;
                  }}
                  href={item.href}
                  download={item.download}
                  target={item.external ? "_blank" : undefined}
                  rel={item.external ? "noopener noreferrer" : undefined}
                  role="menuitem"
                  tabIndex={-1}
                  onClick={() => {
                    setOpen(false);
                    setActiveIndex(-1);
                  }}
                  className={cn(itemClassName, item.className)}
                >
                  {content}
                </a>
              );
            }
            return (
              <button
                key={item.label}
                ref={(node) => {
                  itemsRef.current[index] = node;
                }}
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  setActiveIndex(-1);
                  item.onSelect?.();
                }}
                className={cn(itemClassName, item.className)}
              >
                {content}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
