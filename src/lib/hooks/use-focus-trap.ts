"use client";

import { useEffect, type RefObject } from "react";

// Matches the MDN "tabbable" set well enough for single-panel dialogs.
// Intentionally does not filter by offsetParent / visibility — callers
// are expected to mount the trap alongside an aria-modal="true" dialog
// that has no hidden controls.
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface UseFocusTrapOptions {
  /** The dialog/panel element to trap focus within. */
  containerRef: RefObject<HTMLElement | null>;
  /** Called when the user presses Escape while the trap is active. */
  onEscape: () => void;
  /**
   * Gate the trap on modal open state so the hook can be mounted
   * unconditionally. Defaults to true.
   */
  enabled?: boolean;
}

/**
 * Focus-trap + Escape handler for modal dialogs. Subsumes the
 * identical useEffects in NoteModal, PourPickerModal, and AddWineModal:
 *
 *   - Escape → onEscape()
 *   - Tab / Shift+Tab cycles within containerRef
 *   - On mount (while enabled): focus the first focusable
 *   - On unmount (or when disabled): restore focus to the trigger
 *
 * Intentionally document-level: the dialog is the only interactive
 * surface while open (aria-modal="true"), so Tab from anywhere
 * inside must be caught.
 */
export function useFocusTrap({
  containerRef,
  onEscape,
  enabled = true,
}: UseFocusTrapOptions): void {
  useEffect(() => {
    if (!enabled) return;

    // Snapshot the element that opened the modal so we can return
    // focus on close. Runs inside the effect so the snapshot happens
    // after React has moved focus into the dialog if autoFocus fired
    // synchronously.
    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Auto-focus the first focusable in the container. Deferred to
    // the next tick so the children have mounted.
    const focusFrame = requestAnimationFrame(() => {
      const root = containerRef.current;
      if (!root) return;
      const active = document.activeElement;
      // Respect explicit autoFocus inside the dialog — only seed
      // focus if nothing in the container already has it.
      if (active instanceof HTMLElement && root.contains(active)) return;
      const focusables = root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      focusables[0]?.focus();
    });

    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onEscape();
        return;
      }
      if (e.key !== "Tab") return;

      const root = containerRef.current;
      if (!root) return;
      const focusable = Array.from(
        root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKey);

    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKey);
      // Restore focus to the element that opened the modal so
      // keyboard users aren't stranded at the document root.
      previouslyFocused?.focus?.();
    };
  }, [containerRef, onEscape, enabled]);
}
