"use client";

import {
  Copy,
  Download,
  Eye,
  FileSpreadsheet,
  FileText,
  Loader2,
  Printer,
  Share2,
} from "lucide-react";
import { OverflowMenu, type OverflowMenuItem } from "@/components/overflow-menu";
import { cn } from "@/lib/utils";

/**
 * GLOBAL-01 on the wine-list editor — the same rule the cellar is held to.
 *
 * The mobile copy of this row was `flex-wrap`, which is invisible to
 * `scripts/check-control-rows.mjs`: one source container, one counted row,
 * however many lines it paints. Measured at 390px
 * (e2e/mobile-list-editor.test.ts) it was six pills — Download PDF 133,
 * Toast Export 120, CSV 73, Preview 96, Print 79, Publish 91 — 592px of
 * controls in 354px of row, wrapping onto TWO lines, and three on a published
 * list where Copy URL joins them. Nothing was clipped and the page never
 * scrolled sideways, so every existing gate passed while the eye counted
 * three rows.
 *
 * `touchSized` marks the mobile instance, and there the row keeps the two
 * actions a phone is actually used for — see it (Preview) and ship it
 * (Publish) — and demotes the desk work (PDF, Toast, CSV, Print, Copy URL)
 * into one overflow control. 96 + 91 + 44 + gaps = 247px of 354px, one line.
 * The desktop instance is unchanged: measured at 1440px it is six controls on
 * one line with room to spare.
 *
 * SD-12 — `POST /api/wine-lists/{id}/publish` is `requireRole(["owner",
 * "manager"])`, and Publish was the last control on this page still armed for
 * a staff member after the rest of `/lists/[id]` was gated. `canManage` gates
 * exactly that one button; everything else here is a GET (preview, print, CSV,
 * Toast export, copy the public URL) and needs no role, so nothing else moves.
 * Removing it also takes the mobile row from three controls to two.
 */
export function ListActions({
  listId,
  isPublished,
  slug,
  generatingPdf,
  canManage,
  touchSized = false,
  onDownloadPdf,
  onCopyUrl,
  onPublish,
  className,
}: {
  listId: string;
  isPublished: boolean;
  slug: string | null;
  generatingPdf: boolean;
  /** SD-12 — publishing is owner/manager only; every other action here is a GET. */
  canManage: boolean;
  /** The mobile instance: touch copy, and the one-line control budget. */
  touchSized?: boolean;
  onDownloadPdf: () => void;
  onCopyUrl: () => void;
  onPublish: () => void;
  className?: string;
}) {
  const secondaryClassName = cn(
    "items-center gap-xs rounded-pill border border-rule bg-canvas px-sm text-[13px] font-medium text-ink hover:bg-wash focus-ring",
    "inline-flex min-h-11 md:px-md",
  );
  const publishClassName = cn(
    "items-center gap-xs rounded-pill bg-primary px-sm text-[13px] font-medium text-seal-ink hover:bg-primary-hover focus-ring",
    "inline-flex min-h-11 md:px-md",
  );

  const downloadLabel = generatingPdf
    ? touchSized
      ? "Generating PDF"
      : "Generating..."
    : "Download PDF";

  if (touchSized) {
    const menuItems: OverflowMenuItem[] = [
      {
        label: downloadLabel,
        // The label already carries the state; a spinner that cannot spin
        // (the menu renders icons statically) would say less, not more.
        Icon: Download,
        onSelect: onDownloadPdf,
        disabled: generatingPdf,
      },
      {
        label: "Toast Export",
        Icon: FileSpreadsheet,
        href: "/api/export/toast-csv",
        download: "toast-import.csv",
      },
      {
        label: "CSV",
        Icon: FileText,
        href: `/api/wine-lists/${listId}/csv`,
        download: true,
      },
      {
        label: "Print",
        Icon: Printer,
        href: `/lists/${listId}/print`,
        external: true,
      },
      ...(isPublished && slug
        ? [{ label: "Copy URL", Icon: Copy, onSelect: onCopyUrl }]
        : []),
    ];

    return (
      <div data-list-control-row aria-label="List actions" className={className}>
        <a
          href={`/lists/${listId}/preview`}
          target="_blank"
          rel="noopener noreferrer"
          className={secondaryClassName}
        >
          <Eye className="h-3.5 w-3.5" strokeWidth={2} />
          <span>Preview</span>
        </a>
        {canManage && (
          <button type="button" onClick={onPublish} className={publishClassName}>
            <Share2 className="h-3.5 w-3.5" strokeWidth={2} />
            <span>Publish</span>
          </button>
        )}
        <OverflowMenu label="More list actions" items={menuItems} />
      </div>
    );
  }

  return (
    <div data-list-control-row aria-label="List actions" className={className}>
      <button
        type="button"
        onClick={onDownloadPdf}
        disabled={generatingPdf}
        className={cn(secondaryClassName, "disabled:opacity-60")}
      >
        {generatingPdf ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
        ) : (
          <Download className="h-3.5 w-3.5" strokeWidth={2} />
        )}
        <span>{downloadLabel}</span>
      </button>
      <a
        href="/api/export/toast-csv"
        download="toast-import.csv"
        className={secondaryClassName}
      >
        <FileSpreadsheet className="h-3.5 w-3.5" strokeWidth={2} />
        <span>Toast Export</span>
      </a>
      <a
        href={`/api/wine-lists/${listId}/csv`}
        download
        className={secondaryClassName}
      >
        <FileText className="h-3.5 w-3.5" strokeWidth={2} />
        <span>CSV</span>
      </a>
      <a
        href={`/lists/${listId}/preview`}
        target="_blank"
        rel="noopener noreferrer"
        className={secondaryClassName}
      >
        <Eye className="h-3.5 w-3.5" strokeWidth={2} />
        <span>Preview</span>
      </a>
      <a
        href={`/lists/${listId}/print`}
        target="_blank"
        rel="noopener noreferrer"
        className={secondaryClassName}
      >
        <Printer className="h-3.5 w-3.5" strokeWidth={2} />
        <span>Print</span>
      </a>
      {isPublished && slug && (
        <button type="button" onClick={onCopyUrl} className={secondaryClassName}>
          <Copy className="h-3.5 w-3.5" strokeWidth={2} />
          <span>Copy URL</span>
        </button>
      )}
      {canManage && (
        <button type="button" onClick={onPublish} className={publishClassName}>
          <Share2 className="h-3.5 w-3.5" strokeWidth={2} />
          <span>Publish</span>
        </button>
      )}
    </div>
  );
}
