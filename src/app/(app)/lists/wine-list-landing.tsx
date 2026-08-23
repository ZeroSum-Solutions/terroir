"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Archive,
  ArchiveRestore,
  Check,
  Copy,
  ExternalLink,
  Files,
  ListOrdered,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";
import { ActionDialog } from "@/components/action-dialog";
import { RouteDataEmpty } from "@/components/route-data-state";
import { TimeAgo } from "@/components/time-ago";
import type { WineListWithCount } from "@/lib/wine-list/types";

export function WineListLanding({
  lists,
  archivedLists = [],
  showArchived = false,
}: {
  lists: WineListWithCount[];
  archivedLists?: WineListWithCount[];
  showArchived?: boolean;
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // Per-card "copied" indicator for the published-list footer — tracks
  // the list id whose public link was most recently copied so we can
  // flash a confirmation on that card only. Mirrors the team-page
  // per-row invitation copy pattern.
  const [copiedListId, setCopiedListId] = useState<string | null>(null);
  // Tracks the list id currently being deleted so we can disable its
  // Delete button while the request is in flight. Surface API errors in
  // an inline alert above the grid so the user sees what failed.
  const [deletingListId, setDeletingListId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WineListWithCount | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Tracks which list is being archived/unarchived
  const [archivingListId, setArchivingListId] = useState<string | null>(null);
  // Tracks which list is being cloned
  const [cloningListId, setCloningListId] = useState<string | null>(null);

  const copyListLink = useCallback(async (list: WineListWithCount) => {
    if (!list.slug) return;
    const url = `${window.location.origin}/list/${list.slug}`;
    await navigator.clipboard.writeText(url);
    setCopiedListId(list.id);
    setTimeout(
      () =>
        setCopiedListId((current) => (current === list.id ? null : current)),
      2000,
    );
  }, []);

  const toggleArchive = useCallback(
    async (list: WineListWithCount) => {
      const willArchive = !list.archived;
      const action = willArchive ? "archive" : "unarchive";
      const confirmMessage = willArchive
        ? `Archive "${list.name}"? It will be hidden from the default view but can be restored later.`
        : `Restore "${list.name}"? It will appear in the default view again.`;
      if (!window.confirm(confirmMessage)) return;

      setArchivingListId(list.id);
      try {
        const res = await fetch(`/api/wine-lists/${list.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ archived: willArchive }),
        });
        if (!res.ok) {
          const body = (await res.json()) as { error?: unknown };
          throw new Error(
            typeof body.error === "string"
              ? body.error
              : `Couldn't ${action} wine list.`,
          );
        }
        router.refresh();
      } catch (err) {
        setDeleteError(
          err instanceof Error && err.message
            ? err.message
            : `Couldn't ${action} wine list. Please try again.`,
        );
      } finally {
        setArchivingListId(null);
      }
    },
    [router],
  );

  const deleteList = useCallback(async () => {
      if (!deleteTarget) return;
      const list = deleteTarget;
      setDeleteError(null);
      setDeletingListId(list.id);
      try {
        const res = await fetch(`/api/wine-lists/${list.id}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          let serverMessage: string | undefined;
          try {
            const body = (await res.json()) as { error?: unknown };
            if (typeof body.error === "string") serverMessage = body.error;
          } catch {
            // non-JSON body — fall through to generic message
          }
          throw new Error(serverMessage ?? "Couldn't delete wine list.");
        }
        setDeleteTarget(null);
        router.refresh();
      } catch (err) {
        setDeleteError(
          err instanceof Error && err.message
            ? err.message
            : "Couldn't delete wine list. Please try again.",
        );
      } finally {
        setDeletingListId(null);
      }
  }, [deleteTarget, router]);

  const requestDeleteList = useCallback((list: WineListWithCount) => {
    // BND-159: only archived lists can be deleted. The API enforces this,
    // but the UI should never offer DELETE on a non-archived list.
    if (!list.archived) return;
    setDeleteError(null);
    setDeleteTarget(list);
  }, []);

  const cloneList = useCallback(
    async (list: WineListWithCount) => {
      const confirmMessage = `Clone "${list.name}"? A new unpublished copy will be created with all sections and items preserved.`;
      if (!window.confirm(confirmMessage)) return;

      setCloningListId(list.id);
      try {
        const res = await fetch(`/api/wine-lists/${list.id}/clone`, {
          method: "POST",
        });
        if (!res.ok) {
          const body = (await res.json()) as { error?: unknown };
          throw new Error(
            typeof body.error === "string"
              ? body.error
              : "Clone failed. Please try again.",
          );
        }
        const { id } = (await res.json()) as { id: string };
        router.refresh();
        // Navigate to the clone
        router.push(`/lists/${id}`);
      } catch (err) {
        setDeleteError(
          err instanceof Error && err.message
            ? err.message
            : "Clone failed. Please try again.",
        );
      } finally {
        setCloningListId(null);
      }
    },
    [router],
  );

  const createList = useCallback(async () => {
    const name = newName.trim() || "Untitled Wine List";
    setCreating(true);
    setCreateError(null);
    try {
      const body: { name: string; description?: string } = { name };
      if (newDescription.trim()) {
        body.description = newDescription.trim();
      }
      const res = await fetch("/api/wine-lists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Failed to create wine list");
      const { id } = (await res.json()) as { id: string };
      router.push(`/lists/${id}`);
    } catch {
      setCreateError("Couldn't create wine list. Please try again.");
      setCreating(false);
    }
  }, [newName, newDescription, router]);

  const renderCard = (list: WineListWithCount) => {
    const justCopied = copiedListId === list.id;
    const showCopyAction = list.is_published && list.slug;
    const isDeleting = deletingListId === list.id;
    const isArchiving = archivingListId === list.id;
    const isCloning = cloningListId === list.id;
    return (
      <div
        key={list.id}
        className="group rounded-card border border-hairline bg-canvas transition-all hover:-translate-y-px hover:border-beige-deep"
      >
        <button
          type="button"
          onClick={() => router.push(`/lists/${list.id}`)}
          className="block w-full rounded-card p-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25"
        >
          <div className="flex items-start justify-between gap-sm">
            <h3 className="font-serif text-[18px] text-ink group-hover:text-primary">
              {list.name}
            </h3>
            <div className="flex items-center gap-xs">
              {list.archived ? (
                <span className="shrink-0 rounded-pill bg-beige px-sm py-xs text-[10.5px] font-medium uppercase tracking-wide text-ink-soft">
                  Archived
                </span>
              ) : list.is_published ? (
                <span className="flex shrink-0 items-center gap-xs rounded-pill bg-sage-wash px-sm py-xs text-[10.5px] font-medium uppercase tracking-wide text-sage-ink">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sage-ink" />
                  Published
                </span>
              ) : (
                <span className="shrink-0 rounded-pill bg-beige px-sm py-xs text-[10.5px] font-medium uppercase tracking-wide text-ink-soft">
                  Draft
                </span>
              )}
            </div>
          </div>
          {list.description && (
            <p className="mt-xs text-[13px] text-ink-muted line-clamp-2">
              {list.description}
            </p>
          )}
          <div className="mt-md flex items-center justify-between text-[12px] text-ink-muted">
            <span>
              <span className="font-medium text-ink">
                {list.wine_count}
              </span>{" "}
              wines
            </span>
            {list.is_published ? (
              <span>
                Published{" "}
                <TimeAgo
                  iso={list.last_published_at ?? list.updated_at}
                />
              </span>
            ) : (
              <span>
                Updated <TimeAgo iso={list.updated_at} />
              </span>
            )}
          </div>
        </button>
        <div className="flex items-center justify-between gap-xs border-t border-hairline px-md py-sm">
          <div className="flex items-center gap-xs">
            {showCopyAction && (
              <>
                <button
                  type="button"
                  onClick={() => copyListLink(list)}
                  aria-label={`Copy public link for ${list.name}`}
                  className="inline-flex min-h-11 items-center gap-xs rounded-pill border border-hairline bg-canvas px-sm text-[12px] font-medium text-ink hover:bg-bridge-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25"
                >
                  {justCopied ? (
                    <Check
                      className="h-3.5 w-3.5"
                      strokeWidth={2}
                      aria-hidden
                    />
                  ) : (
                    <Copy
                      className="h-3.5 w-3.5"
                      strokeWidth={2}
                      aria-hidden
                    />
                  )}
                  {justCopied ? "Copied" : "Copy link"}
                </button>
                <a
                  href={`/list/${list.slug}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open public ${list.name} list in a new tab`}
                  className="inline-flex min-h-11 items-center gap-xs rounded-pill border border-hairline bg-canvas px-sm text-[12px] font-medium text-ink hover:bg-bridge-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25"
                >
                  <ExternalLink
                    className="h-3.5 w-3.5"
                    strokeWidth={2}
                    aria-hidden
                  />
                  Open
                </a>
              </>
            )}
            {/* Clone button — available for all lists */}
            <button
              type="button"
              onClick={() => cloneList(list)}
              disabled={isCloning}
              aria-label={`Clone ${list.name}`}
              className="inline-flex min-h-11 items-center gap-xs rounded-pill border border-hairline bg-canvas px-sm text-[12px] font-medium text-ink hover:bg-bridge-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25 disabled:opacity-60"
            >
              <Files className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              Clone
            </button>
          </div>
          <div className="flex items-center gap-xs">
            <button
              type="button"
              onClick={() => toggleArchive(list)}
              disabled={isArchiving}
              aria-label={
                list.archived
                  ? `Restore ${list.name}`
                  : `Archive ${list.name}`
              }
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-pill border border-hairline bg-canvas text-ink-subtle hover:bg-bridge-surface hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25 disabled:opacity-60"
            >
              {list.archived ? (
                <ArchiveRestore className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              ) : (
                <Archive className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              )}
            </button>
            {/* BND-159: Delete button only shown for archived lists */}
            {list.archived && (
              <button
                type="button"
                onClick={() => requestDeleteList(list)}
                disabled={isDeleting}
                aria-label={`Permanently delete ${list.name}`}
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-pill border border-hairline bg-canvas text-ink-subtle hover:bg-blush-wash hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60"
              >
                <Trash2 className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  const noListsAtAll = lists.length === 0 && archivedLists.length === 0;

  return (
    <section>
      <header className="mb-lg flex flex-col gap-sm md:mb-xl md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="font-serif text-heading-sm text-ink">Wine Lists</h1>
          <p className="mt-xs text-[15px] text-ink-muted">
            Build, publish, and share your menus. Data entered here becomes your
            inventory automatically.
          </p>
        </div>
        <div className="flex items-center gap-sm">
          {archivedLists.length > 0 && (
            <a
              href={showArchived ? "/lists" : "/lists?show_archived=1"}
              className="flex h-11 items-center gap-xs rounded-pill border border-ink/25 bg-transparent px-md text-[13px] font-medium text-ink hover:bg-bridge-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25 self-start md:self-auto"
            >
              <Archive className="h-4 w-4" strokeWidth={2} />
              {showArchived ? "Hide archived" : `Show archived (${archivedLists.length})`}
            </a>
          )}
          <button
            type="button"
            onClick={() => setShowModal(true)}
            className="flex h-11 items-center gap-sm self-start rounded-pill bg-primary px-md text-[14px] font-medium text-white hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:ring-offset-2 md:self-auto"
          >
            <Plus className="h-4 w-4" strokeWidth={2} />
            New wine list
          </button>
        </div>
      </header>

      {deleteError && deleteTarget === null && (
        <div
          role="alert"
          className="mb-md flex items-start justify-between gap-sm rounded-md border border-primary/30 bg-blush-wash px-sm py-xs text-[13px] text-primary"
        >
          <span>{deleteError}</span>
          <button
            type="button"
            onClick={() => setDeleteError(null)}
            aria-label="Dismiss error"
            className="-mr-2xs flex h-6 w-6 shrink-0 items-center justify-center rounded-pill text-primary/70 hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <X className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          </button>
        </div>
      )}

      {noListsAtAll ? (
        <RouteDataEmpty
          icon={<ListOrdered className="h-6 w-6" strokeWidth={1.5} />}
          title="Create your first wine list"
          description="Your guests will thank you."
          action={
            <button
              type="button"
              onClick={() => setShowModal(true)}
              className="inline-flex h-11 items-center gap-sm rounded-pill bg-primary px-md text-[14px] font-medium text-white hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:ring-offset-2"
            >
              <Plus className="h-4 w-4" strokeWidth={2} />
              New wine list
            </button>
          }
        />
      ) : (
        <>
          {/* Active lists */}
          {lists.length > 0 && (
            <div className="grid gap-md md:grid-cols-[repeat(auto-fill,minmax(280px,1fr))]">
              {lists.map(renderCard)}
              <button
                type="button"
                onClick={() => setShowModal(true)}
                className="flex flex-col items-center justify-center gap-sm rounded-card border border-dashed border-beige-deep p-xl text-center text-ink-subtle transition-colors hover:border-primary hover:text-primary"
              >
                <Plus className="h-5 w-5" strokeWidth={2} />
                <span className="text-[14px] font-medium">Create a new list</span>
                <span className="text-[12px]">Start from scratch or a template</span>
              </button>
            </div>
          )}

          {/* Archived lists (shown when toggled) */}
          {showArchived && archivedLists.length > 0 && (
            <div className="mt-xl">
              <h2 className="mb-md font-serif text-[20px] text-ink-muted">
                Archived
              </h2>
              <div className="grid gap-md md:grid-cols-[repeat(auto-fill,minmax(280px,1fr))]">
                {archivedLists.map(renderCard)}
              </div>
            </div>
          )}

          {/* All lists are archived, none active */}
          {lists.length === 0 && !showArchived && archivedLists.length > 0 && (
            <div className="flex flex-col items-center justify-center rounded-card border border-dashed border-beige-deep bg-bridge-surface px-lg py-3xl text-center">
              <Archive
                className="mb-md h-10 w-10 text-ink-subtle"
                strokeWidth={1.5}
              />
              <p className="text-[15px] font-medium text-ink">
                All wine lists are archived
              </p>
              <p className="mt-xs text-[13px] text-ink-muted">
                Restore them or create a new one.
              </p>
              <Link
                href="/lists?show_archived=1"
                className="mt-lg inline-flex h-11 items-center gap-sm rounded-pill border border-ink/25 bg-transparent px-md text-[13px] font-medium text-ink hover:bg-bridge-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25"
              >
                <Archive className="h-4 w-4" strokeWidth={2} />
                Show archived lists
              </Link>
            </div>
          )}
        </>
      )}

      {/* Create modal */}
      {showModal && (
        <CreateListModal
          newName={newName}
          setNewName={(v) => {
            setNewName(v);
            if (createError) setCreateError(null);
          }}
          newDescription={newDescription}
          setNewDescription={(v) => {
            setNewDescription(v);
            if (createError) setCreateError(null);
          }}
          creating={creating}
          error={createError}
          onClose={() => {
            setShowModal(false);
            setCreateError(null);
          }}
          onCreate={createList}
        />
      )}

      <ActionDialog
        open={deleteTarget !== null}
        title="Permanently delete list"
        description={
          deleteTarget?.is_published
            ? `Permanently delete "${deleteTarget.name}"? This list is currently published — its public link will stop working immediately. This cannot be undone.`
            : deleteTarget
              ? `Permanently delete "${deleteTarget.name}"? Its sections and items will be removed. This cannot be undone.`
              : ""
        }
        confirmLabel="Permanently delete list"
        busy={deletingListId === deleteTarget?.id}
        onClose={() => setDeleteTarget(null)}
        onConfirm={deleteList}
      >
        {deleteError && (
          <p
            role="alert"
            className="rounded-md border border-primary/30 bg-blush-wash px-sm py-xs text-[13px] text-primary"
          >
            {deleteError}
          </p>
        )}
      </ActionDialog>
    </section>
  );
}

function CreateListModal({
  newName,
  setNewName,
  newDescription,
  setNewDescription,
  creating,
  error,
  onClose,
  onCreate,
}: {
  newName: string;
  setNewName: (v: string) => void;
  newDescription: string;
  setNewDescription: (v: string) => void;
  creating: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: () => void;
}) {
  const trapRef = useRef<HTMLDivElement>(null);
  useFocusTrap({ containerRef: trapRef, onEscape: onClose });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-md"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-wine-list-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={trapRef}
        className="w-full max-w-[400px] rounded-card border border-hairline bg-canvas p-lg"
      >
        <h2
          id="new-wine-list-title"
          className="font-serif text-[22px] text-ink"
        >
          New wine list
        </h2>
        <p className="mt-xs text-[13px] text-ink-muted">
          Default sections will be created. You can rename or add more later.
        </p>
        <input
          autoFocus
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onCreate();
          }}
          placeholder="Spring 2026 Wine List…"
          className="mt-lg h-[38px] w-full rounded-pill border border-hairline bg-canvas px-md text-[14px] text-ink placeholder:text-ink-subtle focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25"
        />
        <textarea
          value={newDescription}
          onChange={(e) => setNewDescription(e.target.value)}
          placeholder="Description (optional)"
          rows={3}
          className="mt-sm w-full rounded-md border border-hairline bg-canvas px-sm py-xs text-[14px] text-ink placeholder:text-ink-subtle focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25 resize-none"
        />
        {error && (
          <p
            role="alert"
            className="mt-sm rounded-md border border-primary/30 bg-blush-wash px-sm py-xs text-[13px] text-primary"
          >
            {error}
          </p>
        )}
        <div className="mt-lg flex justify-end gap-sm">
          <button
            type="button"
            onClick={onClose}
            className="h-[38px] rounded-pill border border-hairline px-md text-[14px] font-medium text-ink hover:bg-bridge-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onCreate}
            disabled={creating}
            className="h-[38px] rounded-pill bg-primary px-md text-[14px] font-medium text-white hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:ring-offset-2 disabled:opacity-60"
          >
            {creating ? "Creating..." : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
