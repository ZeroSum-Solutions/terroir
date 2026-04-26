"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ChevronDown,
  Download,
  FileSpreadsheet,
  Loader2,
  Plus,
  Share2,
} from "lucide-react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { cn } from "@/lib/utils";
import type { WineList } from "@/lib/wine-list/types";
import { type Template } from "@/lib/wine-list/types";
import { SortableWineRow } from "./components/wine-row";
import { AddWineModal } from "./components/add-wine-modal";
import { PublishModal } from "./components/publish-modal";
import { TemplatePicker } from "./components/template-picker";

type Wine = {
  id: string;
  name: string;
  producer: string;
  vintage: number | null;
  varietal: string | null;
  region: string | null;
  drink_window_start?: number | null;
  drink_window_end?: number | null;
  serving_temp_min?: number | null;
  serving_temp_max?: number | null;
  serving_temp_label?: string | null;
};

type ListItem = {
  id: string;
  section_id: string;
  wine_id: string;
  position: number;
  glass_price: number | null;
  bottle_price: number | null;
  // BND-038: per-wine pour config. glass_pour_ml = null means the wine
  // is not pour-tracked (bottle-only). pour_size_mode 'picker' opens the
  // picker modal on /pour instead of immediate subtraction.
  glass_pour_ml: number | null;
  pour_size_mode: "fixed" | "picker";
  tasting_note: string | null;
  // ARCH-017: is_available deprecated by BND-037's is_eightysixed.
  // Not writable via PATCH; dropped from the editor state so it
  // can't drift back into mutations.
  wines: Wine;
};

type Section = {
  id: string;
  name: string;
  position: number;
  wine_list_id: string;
  wine_list_items: ListItem[];
};

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

  const [showAddWine, setShowAddWine] = useState(false);
  const [showPublish, setShowPublish] = useState(false);
  const [generatingPdf, setGeneratingPdf] = useState(false);

  const totalWines = useMemo(
    () => sections.reduce((sum, s) => sum + s.wine_list_items.length, 0),
    [sections],
  );

  const addWineToSection = useCallback(
    async (wineId: string, glassPrice: number | null, bottlePrice: number | null) => {
      if (!activeSection) return;
      const res = await fetch("/api/wine-list-items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          section_id: activeSection,
          wine_id: wineId,
          glass_price: glassPrice,
          bottle_price: bottlePrice,
        }),
      });
      if (res.ok) {
        setShowAddWine(false);
        startTransition(() => router.refresh());
      }
    },
    [activeSection, router],
  );

  // BND-025: wire 'Add section' button. window.prompt() is the minimal
  // viable UX; an inline-rename input is a polish follow-up.
  // TODO (wine-list-editor UX polish): replace with an inline text
  // input that takes the spot of the 'Add section' button — commits
  // on Enter / blur, Esc cancels. Matches DESIGN.md 'no browser
  // chrome in app UI' intent. ~50 LOC, deferred out of BND-025.
  const addSection = useCallback(async () => {
    const raw = window.prompt("New section name");
    if (raw === null) return;
    const name = raw.trim();
    if (!name) return;

    const res = await fetch("/api/wine-list-sections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wine_list_id: list.id, name }),
    });

    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as { error?: string } | null;
      window.alert(payload?.error ?? `Failed to add section (${res.status}).`);
      return;
    }

    const created = (await res.json()) as { id: string };
    setActiveSection(created.id);
    startTransition(() => router.refresh());
  }, [list.id, router]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id || !currentSection) return;

      const items = [...currentSection.wine_list_items];
      const oldIndex = items.findIndex((i) => i.id === active.id);
      const newIndex = items.findIndex((i) => i.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;

      // Reorder locally
      const [moved] = items.splice(oldIndex, 1);
      items.splice(newIndex, 0, moved);

      // Optimistic update
      setSections((prev) =>
        prev.map((s) =>
          s.id === activeSection
            ? { ...s, wine_list_items: items.map((it, idx) => ({ ...it, position: idx })) }
            : s,
        ),
      );

      // Persist
      await fetch("/api/wine-list-items/reorder", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderedIds: items.map((i) => i.id) }),
      });
    },
    [currentSection, activeSection],
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

  const updateItemPrice = useCallback(
    async (
      itemId: string,
      field: "glass_price" | "bottle_price",
      value: number | null,
    ) => {
      // Optimistic update
      setSections((prev) =>
        prev.map((s) => ({
          ...s,
          wine_list_items: s.wine_list_items.map((i) =>
            i.id === itemId ? { ...i, [field]: value } : i,
          ),
        })),
      );

      const res = await fetch(`/api/wine-list-items/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
      if (!res.ok) {
        startTransition(() => router.refresh());
      }
    },
    [router],
  );

  // BND-038: per-item pour config (glass_pour_ml + pour_size_mode).
  // Same optimistic + PATCH shape as price updates. Passing null for
  // glass_pour_ml turns pour tracking off for the wine.
  const updateItemPour = useCallback(
    async (
      itemId: string,
      field: "glass_pour_ml" | "pour_size_mode",
      value: number | "fixed" | "picker" | null,
    ) => {
      setSections((prev) =>
        prev.map((s) => ({
          ...s,
          wine_list_items: s.wine_list_items.map((i) =>
            i.id === itemId ? { ...i, [field]: value } : i,
          ),
        })),
      );

      const res = await fetch(`/api/wine-list-items/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
      if (!res.ok) {
        startTransition(() => router.refresh());
      }
    },
    [router],
  );

  const downloadPdf = useCallback(async () => {
    setGeneratingPdf(true);
    try {
      const res = await fetch("/api/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listId: list.id, template: list.template }),
      });
      if (!res.ok) throw new Error("PDF generation failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${list.name}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setGeneratingPdf(false);
    }
  }, [list.id, list.name, list.template]);

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
          href="/lists"
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
              onClick={downloadPdf}
              disabled={generatingPdf}
              className="flex h-[34px] items-center gap-xs rounded-sm border border-border-strong bg-white px-sm text-[13px] font-medium text-ink hover:bg-surface-muted disabled:opacity-60 md:px-md"
            >
              {generatingPdf ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
              ) : (
                <Download className="h-3.5 w-3.5" strokeWidth={2} />
              )}
              <span className="hidden md:inline">{generatingPdf ? "Generating..." : "Download PDF"}</span>
            </button>
            <a
              href="/api/export/toast-csv"
              download="toast-import.csv"
              className="flex h-[34px] items-center gap-xs rounded-sm border border-border-strong bg-white px-sm text-[13px] font-medium text-ink hover:bg-surface-muted md:px-md"
            >
              <FileSpreadsheet className="h-3.5 w-3.5" strokeWidth={2} />
              <span className="hidden md:inline">Toast Export</span>
            </a>
            <button
              type="button"
              onClick={() => setShowPublish(true)}
              className="flex h-[34px] items-center gap-xs rounded-sm bg-accent px-sm text-[13px] font-medium text-white hover:bg-accent-hover md:px-md"
            >
              <Share2 className="h-3.5 w-3.5" strokeWidth={2} />
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
              onClick={addSection}
              className="flex items-center gap-xs px-sm py-xs text-[13px] text-ink-subtle hover:text-ink"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={2} />
              Add section
            </button>
          </div>

          <div className="mt-lg text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
            Template
          </div>
          <div className="mt-sm">
            <TemplatePicker
              current={list.template}
              onChange={updateTemplate}
              disabled={isPending}
            />
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
                {/* DEBT-014: removed the dead "From scan" button.
                    It had no onClick and the full flow (scan-picker +
                    recent-scans endpoint + batch import) is tracked
                    as BND-034. Rendering a visibly-unresponsive
                    button was worse than omitting it; when BND-034
                    ships it'll add the button back wired up. */}
                <button
                  type="button"
                  onClick={() => setShowAddWine(true)}
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
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={currentSection.wine_list_items.map((i) => i.id)}
                  strategy={verticalListSortingStrategy}
                >
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
                      <SortableWineRow
                        key={item.id}
                        item={item}
                        onDelete={deleteItem}
                        onPriceChange={updateItemPrice}
                        onPourChange={updateItemPour}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            )}

            {/* Add another wine footer */}
            <div className="border-t border-dashed border-border px-lg py-md text-center">
              <button
                type="button"
                onClick={() => setShowAddWine(true)}
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

      {showAddWine && currentSection && (
        <AddWineModal
          sectionName={currentSection.name}
          onAdd={addWineToSection}
          onClose={() => setShowAddWine(false)}
        />
      )}

      {showPublish && (
        <PublishModal
          listId={list.id}
          currentSlug={list.slug}
          isPublished={list.is_published}
          onClose={() => {
            setShowPublish(false);
            startTransition(() => router.refresh());
          }}
        />
      )}
    </section>
  );
}
