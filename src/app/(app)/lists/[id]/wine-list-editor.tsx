"use client";

import { useCallback, useMemo, useState, useTransition, useRef, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ChevronDown, Plus, X } from "lucide-react";
import { DndContext, closestCenter } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { ActionDialog } from "@/components/action-dialog";
import type { WineList } from "@/lib/wine-list/types";
import { type Template } from "@/lib/wine-list/types";
import { SortableWineRow } from "./components/wine-row";
import { AddWineModal } from "./components/add-wine-modal";
import { PublishModal } from "./components/publish-modal";
import { TemplatePicker } from "./components/template-picker";
import {
  BrandKitPanel,
  type BrandKitView,
} from "./components/brand-kit-panel";
import { ListActions } from "./components/list-actions";
import { SortableSectionButton } from "./components/sortable-section-button";
import { useSectionReorder } from "./use-section-reorder";
import { useWineItemReorder } from "./use-wine-item-reorder";
import { useAddWine } from "./use-add-wine";
import type {
  WineListEditorItem,
  WineListEditorSection,
} from "./wine-list-editor.types";

export type {
  WineListEditorWine,
  WineListEditorItem,
  WineListEditorSection,
} from "./wine-list-editor.types";

export function WineListEditor({
  list,
  sections: initialSections,
  brandKit,
  canManageBranding,
}: {
  list: Omit<WineList, "wine_list_sections">;
  sections: WineListEditorSection[];
  brandKit: BrandKitView | null;
  canManageBranding: boolean;
}) {
  const router = useRouter();
  const [sections, setSections] = useState(initialSections);
  const [activeSection, setActiveSection] = useState(
    initialSections[0]?.id ?? "",
  );
  const [isPending, startTransition] = useTransition();

  // BND-161: inline rename state
  const [editingSectionId, setEditingSectionId] = useState<string | null>(null);
  const [editSectionName, setEditSectionName] = useState("");
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const mobileEditInputRef = useRef<HTMLInputElement | null>(null);
  const settledRenameRef = useRef<string | null>(null);

  // Focus the input when entering edit mode
  useEffect(() => {
    if (editingSectionId) {
      const input =
        window.innerWidth < 768
          ? mobileEditInputRef.current
          : editInputRef.current;
      input?.focus();
      input?.select();
    }
  }, [editingSectionId]);

  // BND-163: delete confirmation state
  const [deleteTarget, setDeleteTarget] =
    useState<WineListEditorSection | null>(null);

  // BND-194: delete wine item confirmation state
  const [wineToDelete, setWineToDelete] =
    useState<WineListEditorItem | null>(null);

  const currentSection = useMemo(
    () => sections.find((s) => s.id === activeSection),
    [sections, activeSection],
  );

  const [showAddWine, setShowAddWine] = useState(false);
  const [showPublish, setShowPublish] = useState(false);
  const [generatingPdf, setGeneratingPdf] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [errorToast, setErrorToast] = useState<string | null>(null);
  const [addingSection, setAddingSection] = useState(false);
  const [deletingItem, setDeletingItem] = useState(false);
  const [deletingSection, setDeletingSection] = useState(false);

  /** The neutral confirmation toast, shared by copy-URL and add-wine (LIST-06). */
  const showNotice = useCallback((message: string) => {
    setNotice(message);
    setTimeout(() => setNotice(null), 2500);
  }, []);
  const closeAddWine = useCallback(() => setShowAddWine(false), []);
  const refreshServerProps = useCallback(
    () => startTransition(() => router.refresh()),
    [router],
  );

  const totalWines = useMemo(
    () => sections.reduce((sum, s) => sum + s.wine_list_items.length, 0),
    [sections],
  );

  // BND-161: commit inline rename
  const commitRename = useCallback(async () => {
    const id = editingSectionId;
    const name = editSectionName.trim();
    if (!id || !name) {
      setEditingSectionId(null);
      return;
    }
    if (settledRenameRef.current === id) return;
    settledRenameRef.current = id;

    // Optimistic update
    setSections((prev) =>
      prev.map((s) => (s.id === id ? { ...s, name } : s)),
    );
    setEditingSectionId(null);

    const res = await fetch(`/api/wine-list-sections/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });

    if (!res.ok) {
      startTransition(() => router.refresh());
    }
  }, [editingSectionId, editSectionName, router]);

  const cancelRename = useCallback(() => {
    if (editingSectionId) settledRenameRef.current = editingSectionId;
    setEditingSectionId(null);
  }, [editingSectionId]);

  const startRename = useCallback((id: string, name: string) => {
    settledRenameRef.current = null;
    setEditingSectionId(id);
    setEditSectionName(name);
  }, []);

  // BND-163: delete section
  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeletingSection(true);
    setErrorToast(null);
    const target = deleteTarget;
    const targetId = target.id;

    // Optimistic update
    setSections((prev) => prev.filter((s) => s.id !== targetId));

    // If the deleted section was active, switch to the first remaining
    if (activeSection === targetId) {
      setSections((prev) => {
        const remaining = prev.filter((s) => s.id !== targetId);
        if (remaining.length > 0) setActiveSection(remaining[0].id);
        return remaining;
      });
    }

    try {
      const res = await fetch(`/api/wine-list-sections/${targetId}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        startTransition(() => router.refresh());
        setErrorToast("Couldn't delete section. Please try again.");
        return;
      }
      setDeleteTarget(null);
    } catch {
      startTransition(() => router.refresh());
      setErrorToast("Couldn't delete section. Please try again.");
    } finally {
      setDeletingSection(false);
    }
  }, [deleteTarget, activeSection, router]);

  // LIST-06 — the add-wine write, its local state resync, and its reporting.
  const addWineToSection = useAddWine({
    sections,
    setSections,
    setActiveSection,
    setNotice: showNotice,
    setErrorToast,
    closeModal: closeAddWine,
    refresh: refreshServerProps,
  });

  const addSection = useCallback(async () => {
    const raw = window.prompt("New section name");
    if (raw === null) return;
    const name = raw.trim();
    if (!name) return;

    setAddingSection(true);
    try {
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

      const created = (await res.json()) as Pick<
        WineListEditorSection,
        "id" | "wine_list_id" | "name" | "position"
      >;
      setSections((previous) => [
        ...previous,
        { ...created, wine_list_items: [] },
      ]);
      setActiveSection(created.id);
      startTransition(() => router.refresh());
    } finally {
      setAddingSection(false);
    }
  }, [list.id, router]);

  // BND-162: section sidebar drag-and-drop wiring.
  const { sectionSensors, handleSectionDragEnd } = useSectionReorder(
    sections,
    setSections,
    setErrorToast,
  );

  // Wine-item drag-and-drop wiring (within a section).
  const { wineSensors, handleDragEnd } = useWineItemReorder(
    currentSection,
    activeSection,
    setSections,
    setErrorToast,
  );

  const deleteItem = useCallback(
    async (itemId: string) => {
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
        startTransition(() => router.refresh());
      }
    },
    [router],
  );

  const requestDeleteItem = useCallback(function(item: WineListEditorItem) {
    setWineToDelete(item);
  }, []);

  const confirmDeleteItem = useCallback(async function() {
    const target = wineToDelete;
    if (!target) return;
    setDeletingItem(true);
    setWineToDelete(null);
    try { await deleteItem(target.id); } finally { setDeletingItem(false); }
  }, [wineToDelete, deleteItem]);

  const updateItemPrice = useCallback(
    async (
      itemId: string,
      field: "glass_price" | "bottle_price",
      value: number | null,
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

  const updateItemName = useCallback(
    async (itemId: string, value: string | null) => {
      setSections((prev) =>
        prev.map((s) => ({
          ...s,
          wine_list_items: s.wine_list_items.map((i) =>
            i.id === itemId ? { ...i, name_override: value } : i,
          ),
        })),
      );

      const res = await fetch(`/api/wine-list-items/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name_override: value }),
      });
      if (!res.ok) {
        startTransition(() => router.refresh());
      }
    },
    [router],
  );
  const updateItemBlurb = useCallback(
    async (itemId: string, value: string | null) => {
      setSections((prev) =>
        prev.map((s) => ({
          ...s,
          wine_list_items: s.wine_list_items.map((i) =>
            i.id === itemId ? { ...i, blurb: value } : i,
          ),
        })),
      );

      const res = await fetch(`/api/wine-list-items/${itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blurb: value }),
      });
      if (!res.ok) {
        startTransition(() => router.refresh());
      }
    },
    [router],
  );

  const updateItemHidden = useCallback(
    async (itemId: string, value: boolean) => {
      setSections((prev) =>
        prev.map((s) => ({
          ...s,
          wine_list_items: s.wine_list_items.map((i) =>
            i.id === itemId ? { ...i, hidden: value } : i,
          ),
        })),
      );

      const res = await fetch(`/api/wine-list-items/${itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden: value }),
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
        body: JSON.stringify({ listId: list.id }),
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
  }, [list.id, list.name]);

  const copyUrl = useCallback(() => {
    if (!list.slug) return;
    const url = `${window.location.origin}/list/${list.slug}`;
    navigator.clipboard.writeText(url).then(() => {
      showNotice("URL copied to clipboard.");
    }).catch(() => {
      // Clipboard API may fail in insecure contexts — silently ignore.
    });
  }, [list.slug, showNotice]);

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
          className="mb-sm inline-flex min-h-11 items-center gap-xs text-[13px] text-grey hover:text-ink focus-ring"
        >
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} />
          All lists
        </Link>
        <div className="flex flex-col gap-sm md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="font-serif text-heading-sm text-ink">{list.name}</h1>
            <p className="mt-xs text-[13px] text-grey">
              {list.is_published ? (
                <span className="mr-sm inline-flex items-center gap-xs rounded-pill bg-ready-wash px-sm py-xs text-[10.5px] font-medium uppercase tracking-wide text-ready-ink">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ready-ink" />
                  Published
                </span>
              ) : (
                <span className="mr-sm inline-flex items-center gap-xs rounded-pill bg-surface-sunken px-sm py-xs text-[10.5px] font-medium uppercase tracking-wide text-ink-soft">
                  Draft
                </span>
              )}
              {totalWines} wines
            </p>
          </div>
          <ListActions
            listId={list.id}
            isPublished={list.is_published}
            slug={list.slug}
            generatingPdf={generatingPdf}
            onDownloadPdf={downloadPdf}
            onCopyUrl={copyUrl}
            onPublish={() => setShowPublish(true)}
            className="hidden gap-sm self-start md:flex md:self-auto"
          />
        </div>
      </header>

      <div
        data-testid="mobile-list-controls"
        className="mb-md space-y-md md:hidden"
      >
        <ListActions
          listId={list.id}
          isPublished={list.is_published}
          slug={list.slug}
          generatingPdf={generatingPdf}
          touchSized
          onDownloadPdf={downloadPdf}
          onCopyUrl={copyUrl}
          onPublish={() => setShowPublish(true)}
          className="flex max-w-full flex-wrap gap-xs"
        />

        {sections.length === 0 ? (
          <section className="rounded-card border border-dashed border-rule p-lg text-center">
            <h2 className="font-serif text-[22px] text-ink">Start your list</h2>
            <p className="mt-xs text-[14px] text-grey">
              Add a section before adding wines.
            </p>
            <button
              type="button"
              onClick={addSection}
              disabled={addingSection}
              className="mt-md min-h-11 rounded-pill bg-primary px-md text-[13px] font-medium text-seal-ink hover:bg-primary-hover focus-ring disabled:opacity-50"
            >
              Add first section
            </button>
          </section>
        ) : (
          <div>
            <label
              htmlFor="mobile-section"
              className="text-caption font-medium uppercase text-grey"
            >
              Section
            </label>
            <div className="relative mt-xs">
              <select
                id="mobile-section"
                value={activeSection}
                onChange={(e) => setActiveSection(e.target.value)}
                className="h-11 w-full appearance-none rounded-pill border border-rule bg-canvas px-sm pr-xl text-[14px] font-medium text-ink focus:border-accent focus-ring"
              >
                {sections.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.wine_list_items.length})
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-sm top-1/2 h-4 w-4 -translate-y-1/2 text-grey" />
            </div>

            {currentSection && editingSectionId === currentSection.id ? (
              <input
                ref={mobileEditInputRef}
                type="text"
                aria-label="Section name"
                value={editSectionName}
                onChange={(event) => setEditSectionName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitRename();
                  if (event.key === "Escape") cancelRename();
                }}
                onBlur={commitRename}
                className="mt-xs min-h-11 w-full rounded-pill border border-accent bg-surface px-sm text-[14px] font-medium text-ink outline-none focus-ring"
              />
            ) : currentSection ? (
              <div className="mt-sm grid grid-cols-3 gap-xs">
                <button
                  type="button"
                  aria-label={`Rename ${currentSection.name}`}
                  onClick={() => startRename(currentSection.id, currentSection.name)}
                  className="min-h-11 rounded-pill border border-rule px-xs text-[13px] font-medium text-ink hover:bg-wash focus-ring"
                >
                  Rename
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${currentSection.name}`}
                  onClick={() => setDeleteTarget(currentSection)}
                  className="min-h-11 rounded-pill border border-risk-ink/30 px-xs text-[13px] font-medium text-risk-ink hover:bg-risk-wash focus-ring"
                >
                  Delete
                </button>
                <button
                  type="button"
                  onClick={addSection}
                  disabled={addingSection}
                  className="min-h-11 rounded-pill border border-rule px-xs text-[13px] font-medium text-ink hover:bg-wash focus-ring disabled:opacity-50"
                >
                  Add section
                </button>
              </div>
            ) : null}
          </div>
        )}

        <div>
          <h2
            id="mobile-template-heading"
            className="text-caption font-medium uppercase text-grey"
          >
            Template
          </h2>
          <div className="mt-sm">
            <TemplatePicker
              current={list.template}
              onChange={updateTemplate}
              disabled={isPending}
              ariaLabelledby="mobile-template-heading"
            />
          </div>
        </div>
      </div>

      {/* Desktop: sidebar + content */}
      <div className="md:grid md:grid-cols-[288px_1fr] md:gap-lg">
        {/* Desktop sidebar */}
        <aside className="hidden md:block">
          <div className="text-caption font-medium uppercase text-grey">
            Sections
          </div>
          <div className="mt-sm flex flex-col gap-2xs">
            <DndContext
              id="wine-list-sections-dnd"
              sensors={sectionSensors}
              collisionDetection={closestCenter}
              onDragEnd={handleSectionDragEnd}
            >
              <SortableContext
                items={sections.map((s) => s.id)}
                strategy={verticalListSortingStrategy}
              >
                {sections.map((s) => (
                  <SortableSectionButton
                    key={s.id}
                    section={s}
                    isActive={activeSection === s.id}
                    onSelect={() => setActiveSection(s.id)}
                    onDelete={setDeleteTarget}
                    editingId={editingSectionId}
                    editName={editSectionName}
                    onEditStart={startRename}
                    onEditChange={setEditSectionName}
                    onEditCommit={commitRename}
                    onEditCancel={cancelRename}
                    editRef={editInputRef}
                  />
                ))}
              </SortableContext>
            </DndContext>
            <button
              type="button"
              onClick={addSection}
              disabled={addingSection}
              className="flex min-h-11 items-center gap-xs px-sm py-xs text-[13px] text-grey hover:text-ink disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={2} />
              Add section
            </button>
          </div>

          <div className="mt-lg text-caption font-medium uppercase text-grey">
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
          <div className="rounded-card card-surface">
            {/* Section header */}
            <div className="flex items-center justify-between border-b border-rule px-md py-md md:px-lg">
              <div>
                <h2 className="font-serif text-[22px] font-medium text-ink md:text-[26px]">
                  {currentSection.name}
                </h2>
                <p className="mt-2xs text-[13px] text-grey">
                  {currentSection.wine_list_items.length} wines
                </p>
              </div>
              <div className="flex gap-sm">
                <button
                  type="button"
                  onClick={() => setShowAddWine(true)}
                  className="flex min-h-11 min-w-11 items-center gap-xs rounded-pill bg-primary px-sm text-[13px] font-medium text-seal-ink hover:bg-primary-hover focus-ring"
                >
                  <Plus className="h-3.5 w-3.5" strokeWidth={2} />
                  <span className="hidden sm:inline">Add wine</span>
                </button>
              </div>
            </div>

            {/* Wine items */}
            {currentSection.wine_list_items.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-lg py-3xl text-center">
                <p className="text-[14px] text-grey">
                  No wines in this section yet.
                </p>
                <p className="mt-xs text-[13px] text-grey">
                  Add wines from your inventory or scan a new invoice.
                </p>
              </div>
            ) : (
              <DndContext
                id="wine-list-items-dnd"
                sensors={wineSensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={currentSection.wine_list_items.map((i) => i.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div>
                    {/* Desktop table header */}
                    <div className="hidden border-b border-rule bg-wash px-lg py-xs md:grid md:grid-cols-[28px_1fr_136px_136px_36px]">
                      <div />
                      <div className="text-caption font-medium uppercase text-grey">
                        Wine
                      </div>
                      <div className="text-right text-caption font-medium uppercase text-grey">
                        Glass
                      </div>
                      <div className="text-right text-caption font-medium uppercase text-grey">
                        Bottle
                      </div>
                      <div />
                    </div>

                    {currentSection.wine_list_items.map((item) => (
                      <SortableWineRow
                        key={item.id}
                        item={item}
                        onDelete={() => requestDeleteItem(item)}
                        onPriceChange={updateItemPrice}
                        onPourChange={updateItemPour}
                        onNameChange={updateItemName}
                        onBlurbChange={updateItemBlurb}
                        onHiddenChange={updateItemHidden}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            )}

            {/* Add another wine footer */}
            <div className="border-t border-dashed border-rule px-lg py-md text-center">
              <button
                type="button"
                onClick={() => setShowAddWine(true)}
                className="inline-flex min-h-11 items-center text-[13px] text-grey hover:text-ink focus-ring"
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

      {canManageBranding && (
        <BrandKitPanel
          listId={list.id}
          initialBrandKit={brandKit}
          initialTheme={list.theme}
        />
      )}

            {/* Delete wine confirmation dialog (BND-194) */}
      {wineToDelete && (
        <div className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center bg-scrim p-md">
          <div className="w-full max-w-[384px] rounded-card card-surface">
            <div className="px-lg py-lg">
              <div className="flex items-start justify-between">
                <h3 className="font-serif text-[18px] font-medium text-ink">
                  Remove wine
                </h3>
                <button
                  type="button"
                  onClick={function() { setWineToDelete(null); }}
                  className="rounded-pill p-1 text-grey hover:text-ink"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" strokeWidth={2} />
                </button>
              </div>
              <p className="mt-sm text-[14px] text-grey leading-relaxed">
                Remove{" "}
                <strong className="text-ink">{wineToDelete.wines.producer}, {wineToDelete.wines.name}</strong>
                {wineToDelete.wines.vintage && <span> ({wineToDelete.wines.vintage})</span>}
                {" "}from this wine list?
              </p>
              <p className="mt-xs text-[13px] text-grey">
                The wine will remain in your cellar inventory.
              </p>
              <div className="mt-lg flex justify-end gap-sm">
                <button
                  type="button"
                  onClick={function() { setWineToDelete(null); }}
                  className="rounded-pill border border-rule px-md py-1.5 text-[13px] font-medium text-grey hover:bg-wash focus-ring"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={confirmDeleteItem}
                  disabled={deletingItem}
                  className="rounded-pill bg-primary px-md py-1.5 text-[13px] font-medium text-seal-ink hover:bg-primary-hover focus-ring disabled:opacity-60"
                >
                  Remove wine
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <ActionDialog
        open={deleteTarget !== null}
        title="Delete section"
        description={
          deleteTarget
            ? deleteTarget.wine_list_items.length > 0
              ? `Delete "${deleteTarget.name}"? This will permanently remove ${deleteTarget.wine_list_items.length} wine${deleteTarget.wine_list_items.length !== 1 ? "s" : ""} from this list.`
              : `Delete "${deleteTarget.name}"? This cannot be undone.`
            : ""
        }
        confirmLabel="Delete section"
        busy={deletingSection}
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
      >
        {errorToast && (
          <p
            role="alert"
            className="rounded-md border border-risk-ink/30 bg-risk-wash px-sm py-xs text-[13px] text-risk-ink"
          >
            {errorToast}
          </p>
        )}
      </ActionDialog>

      {showAddWine && currentSection && (
        <AddWineModal
          sections={sections.map((s) => ({ id: s.id, name: s.name }))}
          activeSectionId={activeSection}
          onAdd={addWineToSection}
          onClose={closeAddWine}
        />
      )}

      {showPublish && (
        <PublishModal
          listId={list.id}
          listName={list.name}
          currentSlug={list.slug}
          isPublished={list.is_published}
          onClose={() => {
            setShowPublish(false);
            startTransition(() => router.refresh());
          }}
        />
      )}

      {/* Error toast for failed drag-and-drop reorders */}
      {errorToast && deleteTarget === null && (
        <div className="fixed bottom-[calc(var(--safe-bottom)+var(--spacing-lg))] left-1/2 z-[var(--z-toast)] -translate-x-1/2 rounded-pill bg-primary px-lg py-sm text-[13px] font-medium text-seal-ink animate-in fade-in slide-in-from-bottom-2">
          {errorToast}
        </div>
      )}

      {/* Neutral confirmation toast (copied URL, wine added) */}
      {notice && (
        <div
          role="status"
          className="fixed bottom-[calc(var(--safe-bottom)+var(--spacing-lg))] left-1/2 z-[var(--z-toast)] -translate-x-1/2 rounded-pill bg-surface-inverse px-lg py-sm text-[13px] font-medium text-on-inverse animate-in fade-in slide-in-from-bottom-2"
        >
          {notice}
        </div>
      )}
    </section>
  );
}
