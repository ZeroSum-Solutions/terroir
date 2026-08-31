"use client";

import Link from "next/link";
import { ArrowLeft, Printer } from "lucide-react";

/**
 * Both controls always fitted the frame; neither could be tapped. Measured on
 * the running app at 390px (e2e/one-row-rule.test.ts), "Back to editor" painted
 * 21px tall and Print 36px, against the 44px floor every other control row in
 * this app holds (`min-h-11`). This is the one page a sommelier opens standing
 * at a printer with a phone in one hand.
 */
export function PrintControls({ listId }: { listId: string }) {
  return (
    <div data-print-controls className="mb-lg flex items-center justify-between print:hidden">
      <Link
        href={`/lists/${listId}`}
        className="inline-flex min-h-11 items-center gap-xs text-[13px] text-grey hover:text-ink no-underline focus-ring"
      >
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} />
        Back to editor
      </Link>
      <button
        type="button"
        onClick={() => window.print()}
        className="inline-flex min-h-11 items-center gap-xs rounded-pill bg-primary px-md text-[13px] font-medium text-seal-ink hover:bg-primary-hover focus-ring"
      >
        <Printer className="h-3.5 w-3.5" strokeWidth={2} />
        Print
      </button>
    </div>
  );
}
