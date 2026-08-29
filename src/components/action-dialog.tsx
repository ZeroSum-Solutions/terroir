"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";
import { cn } from "@/lib/utils";

export type ActionTier = "immediate" | "undo" | "confirm";

export function actionNeedsConfirmation(tier: ActionTier): boolean {
  return tier === "confirm";
}

type ActionDialogProps = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  tone?: "danger" | "neutral";
  onConfirm: () => void;
  onClose: () => void;
  children?: ReactNode;
};

export function ActionDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  busy = false,
  tone = "danger",
  onConfirm,
  onClose,
  children,
}: ActionDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(busy);
  const titleId = useId();
  const descriptionId = useId();

  // The stable close callback can run from a descendant layout effect after
  // commit but before passive effects. Keep its snapshot synchronous with the
  // rendered dialog state; these refs are never read while rendering.
  // eslint-disable-next-line react-hooks/refs -- intentional latest-value event ref
  onCloseRef.current = onClose;
  // eslint-disable-next-line react-hooks/refs -- intentional latest-value event ref
  busyRef.current = busy;

  const closeWhenIdle = useCallback(() => {
    if (!busyRef.current) onCloseRef.current();
  }, []);

  useFocusTrap({
    containerRef: panelRef,
    enabled: open,
    onEscape: closeWhenIdle,
  });

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!open) return null;

  function handleBackdrop(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) closeWhenIdle();
  }

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- backdrop-click-to-dismiss is a mouse-only convenience; this dialog already has full keyboard access via useFocusTrap (Escape + explicit action buttons).
    <div
      data-action-dialog-backdrop="true"
      className="fixed inset-0 z-[var(--z-dialog)] flex items-end justify-center bg-scrim p-md sm:items-center"
      onMouseDown={handleBackdrop}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy || undefined}
        className="w-full rounded-t-card card-surface p-lg sm:max-w-[420px] sm:rounded-card"
      >
        <h2 id={titleId} className="font-serif text-[24px] font-normal leading-tight text-ink">
          {title}
        </h2>
        <p id={descriptionId} className="mt-xs text-[14px] leading-relaxed text-grey">
          {description}
        </p>

        {children ? (
          <div className="mt-md" inert={busy || undefined}>
            {children}
          </div>
        ) : null}

        <div className="mt-lg flex flex-col-reverse gap-sm sm:flex-row sm:justify-end">
          <button
            type="button"
            aria-disabled={busy || undefined}
            onClick={closeWhenIdle}
            className="min-h-11 rounded-pill border border-hairline bg-surface px-lg text-[14px] font-medium text-ink transition-colors hover:bg-bridge-surface focus-ring"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={cn(
              "min-h-11 rounded-pill px-lg text-[14px] font-medium transition-colors focus-ring disabled:cursor-not-allowed disabled:opacity-60",
              tone === "danger"
                ? "bg-primary text-white hover:bg-primary-hover"
                : "bg-surface-inverse text-on-inverse hover:bg-ink-soft",
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
