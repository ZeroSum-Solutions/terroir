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
import { cn } from "@/lib/utils";

export function ListActions({
  listId,
  isPublished,
  slug,
  generatingPdf,
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

  return (
    <div aria-label="List actions" className={className}>
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
        <span>
          {generatingPdf
            ? touchSized
              ? "Generating PDF"
              : "Generating..."
            : "Download PDF"}
        </span>
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
      <button type="button" onClick={onPublish} className={publishClassName}>
        <Share2 className="h-3.5 w-3.5" strokeWidth={2} />
        <span>Publish</span>
      </button>
    </div>
  );
}
