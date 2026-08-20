"use client";

import Link from "next/link";
import { ArrowLeft, Printer } from "lucide-react";

export function PrintControls({ listId }: { listId: string }) {
  return (
    <div className="mb-lg flex items-center justify-between print:hidden">
      <Link
        href={`/lists/${listId}`}
        className="inline-flex items-center gap-xs text-[13px] text-ink-muted hover:text-ink no-underline"
      >
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} />
        Back to editor
      </Link>
      <button
        type="button"
        onClick={() => window.print()}
        className="inline-flex h-[36px] items-center gap-xs rounded-pill bg-primary px-md text-[13px] font-medium text-white hover:bg-primary-hover"
      >
        <Printer className="h-3.5 w-3.5" strokeWidth={2} />
        Print
      </button>
    </div>
  );
}
