"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Download,
  Eye,
  FileSpreadsheet,
  GripVertical,
  Loader2,
  MoreHorizontal,
  Plus,
  ScanLine,
  Search,
  Share2,
  Trash2,
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
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
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
                        onDelete={() => deleteItem(item.id)}
                        onUpdatePrice={(field, value) =>
                          updateItemPrice(item.id, field, value)
                        }
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

function SortableWineRow(props: {
  item: ListItem;
  onDelete: () => void;
  onUpdatePrice: (field: "glass_price" | "bottle_price", value: number | null) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.item.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    position: "relative" as const,
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <WineRow
        {...props}
        dragHandleProps={{ ...attributes, ...listeners }}
      />
    </div>
  );
}

function PriceInput({
  value,
  onChange,
  muted,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  muted?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value?.toString() ?? "");

  const commit = () => {
    setEditing(false);
    const parsed = parseFloat(draft);
    if (draft.trim() === "" || draft.trim() === "—") {
      onChange(null);
    } else if (!isNaN(parsed) && parsed >= 0) {
      onChange(Math.round(parsed * 100) / 100);
    }
  };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setDraft(value?.toString() ?? "");
          setEditing(true);
        }}
        className={cn(
          "w-full rounded-sm border border-transparent px-xs py-2xs text-right font-mono text-[14px] transition-colors hover:border-border hover:bg-white",
          muted ? "text-ink-muted" : "text-ink",
        )}
      >
        {formatPrice(value)}
      </button>
    );
  }

  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-xs top-1/2 -translate-y-1/2 font-mono text-[14px] text-ink-subtle">
        $
      </span>
      <input
        autoFocus
        type="text"
        inputMode="decimal"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        className="w-full rounded-sm border border-accent bg-white py-2xs pl-md pr-xs text-right font-mono text-[14px] text-ink outline-none ring-2 ring-accent-soft"
      />
    </div>
  );
}

function WineRow({
  item,
  onDelete,
  onUpdatePrice,
  dragHandleProps,
}: {
  item: ListItem;
  onDelete: () => void;
  onUpdatePrice: (field: "glass_price" | "bottle_price", value: number | null) => void;
  dragHandleProps?: Record<string, unknown>;
}) {
  const wine = item.wines;

  return (
    <>
      {/* Desktop row */}
      <div className="group hidden items-center border-b border-border px-lg py-sm transition-colors last:border-b-0 hover:bg-[#FBFAF6] md:grid md:grid-cols-[28px_1fr_80px_80px_36px]">
        <div
          className="cursor-grab text-ink-subtle opacity-0 transition-opacity group-hover:opacity-100"
          {...dragHandleProps}
        >
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
            {wine.serving_temp_label && (
              <>
                <span className="text-ink-subtle">·</span>
                <span className="text-ink-subtle">{wine.serving_temp_min}–{wine.serving_temp_max}°F</span>
              </>
            )}
            {wine.drink_window_start && wine.drink_window_end && (
              <>
                <span className="text-ink-subtle">·</span>
                <span className="text-ink-subtle">Drink {wine.drink_window_start}–{wine.drink_window_end}</span>
              </>
            )}
          </div>
        </div>
        <PriceInput
          value={item.glass_price}
          onChange={(v) => onUpdatePrice("glass_price", v)}
          muted
        />
        <PriceInput
          value={item.bottle_price}
          onChange={(v) => onUpdatePrice("bottle_price", v)}
        />
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
            <div className="mt-2xs flex flex-wrap items-center gap-xs text-[12px] text-ink-muted">
              <span className="rounded-sm bg-surface-muted px-xs py-2xs font-mono text-[11px] text-ink-subtle">
                {wine.vintage ?? "NV"}
              </span>
              {wine.region && <span>{wine.region}</span>}
            </div>
            {(wine.serving_temp_label || wine.drink_window_start) && (
              <div className="mt-xs flex items-center gap-sm text-[11px] text-ink-subtle">
                {wine.serving_temp_label && (
                  <span>{wine.serving_temp_min}–{wine.serving_temp_max}°F</span>
                )}
                {wine.drink_window_start && wine.drink_window_end && (
                  <span>Drink {wine.drink_window_start}–{wine.drink_window_end}</span>
                )}
              </div>
            )}
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

/* -------------------------------------------------------------------------- */
/* QR code renderer                                                           */
/* -------------------------------------------------------------------------- */
function QrCode({ url }: { url: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    import("qrcode").then((QRCode) => {
      QRCode.toString(url, {
        type: "svg",
        margin: 1,
        color: { dark: "#1A1A1A", light: "#00000000" },
      }).then((svg) => {
        // Safe: SVG is generated by the qrcode library from a URL we control
        if (containerRef.current) containerRef.current.replaceChildren();
        const parser = new DOMParser();
        const doc = parser.parseFromString(svg, "image/svg+xml");
        const svgEl = doc.documentElement;
        if (containerRef.current) containerRef.current.appendChild(svgEl);
      });
    });
  }, [url]);

  return <div ref={containerRef} className="mx-auto w-[200px]" />;
}

/* -------------------------------------------------------------------------- */
/* Publish modal                                                              */
/* -------------------------------------------------------------------------- */
function PublishModal({
  listId,
  currentSlug,
  isPublished,
  onClose,
}: {
  listId: string;
  currentSlug: string | null;
  isPublished: boolean;
  onClose: () => void;
}) {
  const [publishing, setPublishing] = useState(false);
  const [slug, setSlug] = useState(currentSlug);
  const [published, setPublished] = useState(isPublished);
  const [copied, setCopied] = useState(false);

  const publicUrl = slug
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/list/${slug}`
    : null;

  const publish = useCallback(async () => {
    setPublishing(true);
    try {
      const res = await fetch(`/api/wine-lists/${listId}/publish`, {
        method: "POST",
      });
      if (res.ok) {
        const data = (await res.json()) as { slug: string };
        setSlug(data.slug);
        setPublished(true);
      }
    } finally {
      setPublishing(false);
    }
  }, [listId]);

  const copyUrl = () => {
    if (!publicUrl) return;
    navigator.clipboard.writeText(publicUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-md"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-[420px] rounded-md border border-border bg-surface p-lg shadow-lg">
        {!published ? (
          <>
            <h2 className="font-serif text-[22px] text-ink">
              Publish wine list
            </h2>
            <p className="mt-xs text-[13px] text-ink-muted">
              This will create a public page anyone can view. You can unpublish
              at any time.
            </p>
            <div className="mt-lg flex justify-end gap-sm">
              <button
                type="button"
                onClick={onClose}
                className="h-[38px] rounded-sm border border-border-strong px-md text-[14px] font-medium text-ink hover:bg-surface-muted"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={publish}
                disabled={publishing}
                className="h-[38px] rounded-sm bg-accent px-md text-[14px] font-medium text-white hover:bg-accent-hover disabled:opacity-60"
              >
                {publishing ? "Publishing..." : "Publish"}
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 className="font-serif text-[22px] text-ink">
              Your wine list is live
            </h2>

            {publicUrl && (
              <div className="mt-lg">
                <QrCode url={publicUrl} />
              </div>
            )}

            {publicUrl && (
              <div className="mt-lg">
                <div className="flex items-center gap-sm rounded-sm border border-border bg-surface-muted px-sm py-xs">
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-muted">
                    {publicUrl}
                  </span>
                  <button
                    type="button"
                    onClick={copyUrl}
                    className="shrink-0 rounded-sm px-sm py-xs text-[12px] font-medium text-accent hover:bg-accent-soft"
                  >
                    {copied ? "Copied!" : "Copy"}
                  </button>
                </div>
              </div>
            )}

            <div className="mt-lg flex justify-between">
              <a
                href={publicUrl ?? "#"}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[13px] font-medium text-accent hover:underline"
              >
                Open in new tab
              </a>
              <button
                type="button"
                onClick={onClose}
                className="h-[38px] rounded-sm bg-accent px-md text-[14px] font-medium text-white hover:bg-accent-hover"
              >
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Add wine modal                                                             */
/* -------------------------------------------------------------------------- */
type SearchWine = {
  id: string;
  name: string;
  producer: string;
  vintage: number | null;
  varietal: string | null;
  region: string | null;
};

function AddWineModal({
  sectionName,
  onAdd,
  onClose,
}: {
  sectionName: string;
  onAdd: (wineId: string, glass: number | null, bottle: number | null) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchWine[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<SearchWine | null>(null);
  const [bottlePrice, setBottlePrice] = useState("");
  const [glassPrice, setGlassPrice] = useState("");
  const [adding, setAdding] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (query.trim()) params.set("q", query.trim());
        const res = await fetch(`/api/wines/search?${params}`);
        if (res.ok) {
          setResults(await res.json());
        }
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const handleAdd = async () => {
    if (!selected || adding) return;
    setAdding(true);
    const glass = glassPrice ? parseFloat(glassPrice) : null;
    const bottle = bottlePrice ? parseFloat(bottlePrice) : null;
    await onAdd(selected.id, glass, bottle);
    setAdding(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 md:items-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[85vh] w-full flex-col rounded-t-lg border border-border bg-surface shadow-lg md:max-w-[480px] md:rounded-md">
        <div className="border-b border-border px-lg py-md">
          <h2 className="font-serif text-[20px] text-ink">
            Add wine to {sectionName}
          </h2>
          <p className="mt-xs text-[13px] text-ink-muted">
            Search your inventory or browse all wines.
          </p>
        </div>

        {!selected ? (
          <>
            <div className="border-b border-border px-lg py-sm">
              <div className="relative">
                <Search className="pointer-events-none absolute left-sm top-1/2 h-4 w-4 -translate-y-1/2 text-ink-subtle" />
                <input
                  autoFocus
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by producer or wine name..."
                  className="h-[38px] w-full rounded-sm border border-border bg-white pl-xl pr-sm text-[14px] text-ink placeholder:text-ink-subtle focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft"
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {loading ? (
                <div className="flex items-center justify-center py-xl">
                  <Loader2 className="h-5 w-5 animate-spin text-ink-subtle" />
                </div>
              ) : results.length === 0 ? (
                <div className="px-lg py-xl text-center text-[13px] text-ink-muted">
                  {query ? "No wines found." : "No wines in inventory yet. Scan an invoice first."}
                </div>
              ) : (
                results.map((wine) => (
                  <button
                    key={wine.id}
                    type="button"
                    onClick={() => setSelected(wine)}
                    className="flex w-full items-center gap-md border-b border-border/50 px-lg py-sm text-left transition-colors hover:bg-surface-muted"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-serif text-[14px] text-ink">
                        {wine.producer}, {wine.name}
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
                    <Plus className="h-4 w-4 shrink-0 text-ink-subtle" />
                  </button>
                ))
              )}
            </div>
          </>
        ) : (
          <div className="px-lg py-md">
            <div className="rounded-sm border border-border bg-surface-muted px-md py-sm">
              <div className="font-serif text-[14px] font-medium text-ink">
                {selected.producer}, {selected.name}
              </div>
              <div className="mt-2xs text-[12px] text-ink-muted">
                {selected.vintage ?? "NV"}
                {selected.region && ` · ${selected.region}`}
              </div>
            </div>

            <div className="mt-md grid grid-cols-2 gap-md">
              <div>
                <label className="mb-xs block text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
                  Glass price
                </label>
                <div className="relative">
                  <span className="pointer-events-none absolute left-sm top-1/2 -translate-y-1/2 font-mono text-[14px] text-ink-subtle">
                    $
                  </span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={glassPrice}
                    onChange={(e) => setGlassPrice(e.target.value)}
                    placeholder="—"
                    className="h-[38px] w-full rounded-sm border border-border bg-white pl-md pr-sm text-right font-mono text-[14px] text-ink placeholder:text-ink-subtle focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft"
                  />
                </div>
              </div>
              <div>
                <label className="mb-xs block text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
                  Bottle price
                </label>
                <div className="relative">
                  <span className="pointer-events-none absolute left-sm top-1/2 -translate-y-1/2 font-mono text-[14px] text-ink-subtle">
                    $
                  </span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={bottlePrice}
                    onChange={(e) => setBottlePrice(e.target.value)}
                    placeholder="—"
                    className="h-[38px] w-full rounded-sm border border-border bg-white pl-md pr-sm text-right font-mono text-[14px] text-ink placeholder:text-ink-subtle focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft"
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="border-t border-border px-lg py-md">
          <div className="flex justify-end gap-sm">
            {selected && (
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="h-[38px] rounded-sm border border-border-strong px-md text-[14px] font-medium text-ink hover:bg-surface-muted"
              >
                Back
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="h-[38px] rounded-sm border border-border-strong px-md text-[14px] font-medium text-ink hover:bg-surface-muted"
            >
              Cancel
            </button>
            {selected && (
              <button
                type="button"
                onClick={handleAdd}
                disabled={adding}
                className="h-[38px] rounded-sm bg-accent px-md text-[14px] font-medium text-white hover:bg-accent-hover disabled:opacity-60"
              >
                {adding ? "Adding..." : "Add to list"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
