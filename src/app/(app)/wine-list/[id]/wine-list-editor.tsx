"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Download,
  Eye,
  GripVertical,
  MoreHorizontal,
  Plus,
  ScanLine,
  Share2,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { WineList } from "@/lib/wine-list/types";
import { TEMPLATES, type Template } from "@/lib/wine-list/types";

type Wine = {
  id: string;
  name: string;
  producer: string;
  vintage: number | null;
  varietal: string | null;
  region: string | null;
};

type ListItem = {
  id: string;
  section_id: string;
  wine_id: string;
  position: number;
  glass_price: number | null;
  bottle_price: number | null;
  tasting_note: string | null;
  is_available: boolean;
  wines: Wine;
};

type Section = {
  id: string;
  name: string;
  position: number;
  wine_list_id: string;
  wine_list_items: ListItem[];
};

function formatPrice(n: number | null) {
  if (n == null) return "—";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

export function WineListEditor({
  list,
  sections: initialSections,
}: {
  list: Omit<WineList, "wine_list_sections">;
  sections: Section[];
}) {
  const router = useRouter();
  const [sections, setSections] = useState(initialSections);
  const [activeSection, setActiveSection] = useState(
    initialSections[0]?.id ?? "",
  );
  const [isPending, startTransition] = useTransition();

  const currentSection = useMemo(
    () => sections.find((s) => s.id === activeSection),
    [sections, activeSection],
  );

  const totalWines = useMemo(
    () => sections.reduce((sum, s) => sum + s.wine_list_items.length, 0),
    [sections],
  );

  const deleteItem = useCallback(
    async (itemId: string) => {
      // Optimistic update
      setSections((prev) =>
        prev.map((s) => ({
          ...s,
          wine_list_items: s.wine_list_items.filter((i) => i.id !== itemId),
        })),
      );

      const res = await fetch(`/api/wine-list-items/${itemId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        // Revert on failure
        startTransition(() => router.refresh());
      }
    },
    [router],
  );

  const updateTemplate = useCallback(
    async (template: Template) => {
      await fetch(`/api/wine-lists/${list.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template }),
      });
      startTransition(() => router.refresh());
    },
    [list.id, router],
  );

  return (
    <section>
      {/* Header */}
      <header className="mb-lg md:mb-xl">
        <Link
          href="/wine-list"
          className="mb-sm inline-flex items-center gap-xs text-[13px] text-ink-muted hover:text-ink"
        >
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} />
          All lists
        </Link>
        <div className="flex flex-col gap-sm md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="font-serif text-[28px] text-ink">{list.name}</h1>
            <p className="mt-xs text-[13px] text-ink-muted">
              {list.is_published ? (
                <span className="mr-sm inline-flex items-center gap-xs rounded-pill bg-success-soft px-sm py-xs text-[11px] font-medium text-success">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />
                  Published
                </span>
              ) : (
                <span className="mr-sm inline-flex items-center gap-xs rounded-pill bg-surface-sunken px-sm py-xs text-[11px] font-medium text-ink-muted">
                  Draft
                </span>
              )}
              {totalWines} wines
            </p>
          </div>
          <div className="flex gap-sm self-start md:self-auto">
            <button
              type="button"
              className="flex h-[34px] items-center gap-xs rounded-sm border border-border-strong bg-white px-sm text-[13px] font-medium text-ink hover:bg-surface-muted md:px-md"
            >
              <Eye className="h-3.5 w-3.5" strokeWidth={2} />
              <span className="hidden md:inline">Preview PDF</span>
            </button>
            <button
              type="button"
              className="flex h-[34px] items-center gap-xs rounded-sm border border-border-strong bg-white px-sm text-[13px] font-medium text-ink hover:bg-surface-muted md:px-md"
            >
              <Share2 className="h-3.5 w-3.5" strokeWidth={2} />
              <span className="hidden md:inline">Share</span>
            </button>
            <button
              type="button"
              className="flex h-[34px] items-center gap-xs rounded-sm bg-accent px-sm text-[13px] font-medium text-white hover:bg-accent-hover md:px-md"
            >
              <Download className="h-3.5 w-3.5" strokeWidth={2} />
              <span className="hidden md:inline">Publish</span>
            </button>
          </div>
        </div>
      </header>

      {/* Mobile section dropdown */}
      <div className="relative mb-md md:hidden">
        <select
          value={activeSection}
          onChange={(e) => setActiveSection(e.target.value)}
          className="h-11 w-full appearance-none rounded-sm border border-border bg-white px-sm pr-xl text-[14px] font-medium text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft"
        >
          {sections.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.wine_list_items.length})
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-sm top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
      </div>

      {/* Desktop: sidebar + content */}
      <div className="md:grid md:grid-cols-[220px_1fr] md:gap-lg">
        {/* Desktop sidebar */}
        <aside className="hidden md:block">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
            Sections
          </div>
          <div className="mt-sm flex flex-col gap-2xs">
            {sections.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setActiveSection(s.id)}
                className={cn(
                  "flex items-center justify-between rounded-sm px-sm py-xs text-[14px] font-medium transition-colors",
                  activeSection === s.id
                    ? "bg-surface-muted text-ink shadow-sm"
                    : "text-ink-muted hover:bg-surface-muted hover:text-ink",
                )}
              >
                <span>{s.name}</span>
                <span
                  className={cn(
                    "tabular text-[12px]",
                    activeSection === s.id ? "text-ink" : "text-ink-subtle",
                  )}
                >
                  {s.wine_list_items.length}
                </span>
              </button>
            ))}
            <button
              type="button"
              className="flex items-center gap-xs px-sm py-xs text-[13px] text-ink-subtle hover:text-ink"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={2} />
              Add section
            </button>
          </div>

          <div className="mt-lg text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
            Template
          </div>
          <div className="mt-sm flex flex-col gap-2xs">
            {TEMPLATES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => updateTemplate(t)}
                className={cn(
                  "flex items-center justify-between rounded-sm px-sm py-xs text-[14px] transition-colors",
                  list.template === t
                    ? "bg-surface-muted font-medium text-ink shadow-sm"
                    : "text-ink-muted hover:bg-surface-muted hover:text-ink",
                )}
              >
                <span
                  className={
                    t === "classic" || t === "minimal"
                      ? "font-serif"
                      : "font-sans"
                  }
                >
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </span>
                {list.template === t && (
                  <Check
                    className="h-3.5 w-3.5 text-accent"
                    strokeWidth={2.5}
                  />
                )}
              </button>
            ))}
          </div>
        </aside>

        {/* Main content — active section */}
        {currentSection && (
          <div className="rounded-md border border-border bg-surface">
            {/* Section header */}
            <div className="flex items-center justify-between border-b border-border px-md py-md md:px-lg">
              <div>
                <h2 className="font-serif text-[22px] font-medium text-ink md:text-[26px]">
                  {currentSection.name}
                </h2>
                <p className="mt-2xs text-[13px] text-ink-muted">
                  {currentSection.wine_list_items.length} wines
                </p>
              </div>
              <div className="flex gap-sm">
                <button
                  type="button"
                  className="flex h-[30px] items-center gap-xs rounded-sm border border-border-strong bg-white px-sm text-[13px] font-medium text-ink hover:bg-surface-muted"
                >
                  <ScanLine className="h-3.5 w-3.5" strokeWidth={2} />
                  <span className="hidden sm:inline">From scan</span>
                </button>
                <button
                  type="button"
                  className="flex h-[30px] items-center gap-xs rounded-sm bg-accent px-sm text-[13px] font-medium text-white hover:bg-accent-hover"
                >
                  <Plus className="h-3.5 w-3.5" strokeWidth={2} />
                  <span className="hidden sm:inline">Add wine</span>
                </button>
              </div>
            </div>

            {/* Wine items */}
            {currentSection.wine_list_items.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-lg py-3xl text-center">
                <p className="text-[14px] text-ink-muted">
                  No wines in this section yet.
                </p>
                <p className="mt-xs text-[13px] text-ink-subtle">
                  Add wines from your inventory or scan a new invoice.
                </p>
              </div>
            ) : (
              <div>
                {/* Desktop table header */}
                <div className="hidden border-b border-border bg-surface-muted px-lg py-xs md:grid md:grid-cols-[28px_1fr_80px_80px_36px]">
                  <div />
                  <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
                    Wine
                  </div>
                  <div className="text-right text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
                    Glass
                  </div>
                  <div className="text-right text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
                    Bottle
                  </div>
                  <div />
                </div>

                {currentSection.wine_list_items.map((item) => (
                  <WineRow
                    key={item.id}
                    item={item}
                    onDelete={() => deleteItem(item.id)}
                  />
                ))}
              </div>
            )}

            {/* Add another wine footer */}
            <div className="border-t border-dashed border-border px-lg py-md text-center">
              <button
                type="button"
                className="text-[13px] text-ink-subtle hover:text-ink"
              >
                <Plus
                  className="mr-xs inline-block h-3.5 w-3.5"
                  strokeWidth={2}
                />
                Add another wine to {currentSection.name}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function WineRow({
  item,
  onDelete,
}: {
  item: ListItem;
  onDelete: () => void;
}) {
  const wine = item.wines;

  return (
    <>
      {/* Desktop row */}
      <div className="group hidden items-center border-b border-border px-lg py-sm transition-colors last:border-b-0 hover:bg-[#FBFAF6] md:grid md:grid-cols-[28px_1fr_80px_80px_36px]">
        <div className="cursor-grab text-ink-subtle opacity-0 transition-opacity group-hover:opacity-100">
          <GripVertical className="h-4 w-4" strokeWidth={1.5} />
        </div>
        <div>
          <div className="text-[14px] font-medium text-ink">
            <span className="font-serif">
              {wine.producer}, {wine.name}
            </span>
          </div>
          <div className="mt-2xs flex items-center gap-xs text-[12px] text-ink-muted">
            <span className="font-mono text-ink-subtle">
              {wine.vintage ?? "NV"}
            </span>
            {wine.region && (
              <>
                <span className="text-ink-subtle">·</span>
                <span>{wine.region}</span>
              </>
            )}
          </div>
        </div>
        <div className="text-right font-mono text-[14px] text-ink-muted">
          {formatPrice(item.glass_price)}
        </div>
        <div className="text-right font-mono text-[14px] text-ink">
          {formatPrice(item.bottle_price)}
        </div>
        <button
          type="button"
          onClick={onDelete}
          className="flex h-8 w-8 items-center justify-center rounded-sm text-ink-subtle opacity-0 transition-opacity hover:bg-surface-muted hover:text-danger group-hover:opacity-100"
        >
          <Trash2 className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </div>

      {/* Mobile card */}
      <div className="border-b border-border px-md py-md last:border-b-0 md:hidden">
        <div className="flex items-start justify-between">
          <div className="min-w-0 flex-1">
            <div className="font-serif text-[15px] font-medium text-ink">
              {wine.producer}, {wine.name}
            </div>
            <div className="mt-2xs flex items-center gap-xs text-[12px] text-ink-muted">
              <span className="rounded-sm bg-surface-muted px-xs py-2xs font-mono text-[11px] text-ink-subtle">
                {wine.vintage ?? "NV"}
              </span>
              {wine.region && <span>{wine.region}</span>}
            </div>
          </div>
          <button
            type="button"
            onClick={onDelete}
            className="ml-sm flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-ink-subtle hover:text-danger"
          >
            <MoreHorizontal className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>
        <div className="mt-sm flex gap-lg">
          <div>
            <div className="text-[11px] uppercase tracking-[0.06em] text-ink-subtle">
              Glass
            </div>
            <div className="font-mono text-[14px] text-ink-muted">
              {formatPrice(item.glass_price)}
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.06em] text-ink-subtle">
              Bottle
            </div>
            <div className="font-mono text-[14px] text-ink">
              {formatPrice(item.bottle_price)}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
