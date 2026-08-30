"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
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
import { ActionDialog } from "@/components/action-dialog";
import { RouteDataEmpty } from "@/components/route-data-state";
import { StatusChip } from "@/components/status-chip";
import { TimeAgo } from "@/components/time-ago";
import type { WineListWithCount } from "@/lib/wine-list/types";
import { CreateListModal } from "./create-list-modal";
import { useWineListActions } from "./use-wine-list-actions";

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
  const actions = useWineListActions();
  const { deleteTarget } = actions;

  const renderCard = (list: WineListWithCount) => {
    const justCopied = actions.copiedListId === list.id;
    const showCopyAction = list.is_published && list.slug;
    const isDeleting = actions.isDeleting(list.id);
    const isArchiving = actions.isArchiving(list.id);
    const isCloning = actions.isCloning(list.id);
    return (
      <div
        key={list.id}
        className="group rounded-card card-surface transition-all hover:-translate-y-px hover:border-rule-strong"
      >
        <button
          type="button"
          onClick={() => router.push(`/lists/${list.id}`)}
          className="block w-full rounded-card p-md text-left focus-ring"
        >
          <div className="flex items-start justify-between gap-sm">
            <h3 className="font-serif text-[18px] text-ink group-hover:text-accent">
              {list.name}
            </h3>
            <div className="flex items-center gap-xs">
              {/* Wax & Counter (DESIGN.md 2026-08-26): live = the gold
                  marker, draft/archived = quiet ledger stamps. The sage
                  pill was a second accent. */}
              {list.archived ? (
                <StatusChip tone="muted" className="shrink-0">
                  Archived
                </StatusChip>
              ) : list.is_published ? (
                <StatusChip tone="optimal" className="shrink-0">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-mark" />
                  Published
                </StatusChip>
              ) : (
                <StatusChip tone="neutral" className="shrink-0">
                  Draft
                </StatusChip>
              )}
            </div>
          </div>
          {list.description && (
            <p className="mt-xs text-[13px] text-grey line-clamp-2">
              {list.description}
            </p>
          )}
          <div className="mt-md flex items-center justify-between text-[12px] text-grey">
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
        <div className="flex items-center justify-between gap-xs border-t border-rule px-md py-sm">
          <div className="flex items-center gap-xs">
            {showCopyAction && (
              <>
                <button
                  type="button"
                  onClick={() => actions.copyListLink(list)}
                  aria-label={`Copy public link for ${list.name}`}
                  className="inline-flex min-h-11 items-center gap-xs whitespace-nowrap rounded-pill border border-rule bg-canvas px-sm text-[12px] font-medium text-ink hover:bg-wash focus-ring"
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
                  className="inline-flex min-h-11 items-center gap-xs rounded-pill border border-rule bg-canvas px-sm text-[12px] font-medium text-ink hover:bg-wash focus-ring"
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
              onClick={() => actions.cloneList(list)}
              disabled={isCloning}
              aria-label={`Clone ${list.name}`}
              className="inline-flex min-h-11 items-center gap-xs rounded-pill border border-rule bg-canvas px-sm text-[12px] font-medium text-ink hover:bg-wash focus-ring disabled:opacity-60"
            >
              <Files className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              Clone
            </button>
          </div>
          <div className="flex items-center gap-xs">
            <button
              type="button"
              onClick={() => actions.toggleArchive(list)}
              disabled={isArchiving}
              aria-label={
                list.archived
                  ? `Restore ${list.name}`
                  : `Archive ${list.name}`
              }
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-pill border border-rule bg-canvas text-grey hover:bg-wash hover:text-ink focus-ring disabled:opacity-60"
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
                onClick={() => actions.requestDeleteList(list)}
                disabled={isDeleting}
                aria-label={`Permanently delete ${list.name}`}
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-pill border border-rule bg-canvas text-grey hover:bg-risk-wash hover:text-risk-ink focus-ring disabled:opacity-60"
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
          {/* One line — the two-line onboarding pitch pushed the first card
              below ~45% of the mobile viewport (Kimi audit 2026-08-26). */}
          <p className="mt-xs text-[15px] text-grey">
            Published menus sync to inventory automatically.
          </p>
        </div>
        <div className="flex items-center gap-sm">
          {archivedLists.length > 0 && (
            <a
              href={showArchived ? "/lists" : "/lists?show_archived=1"}
              className="flex h-11 items-center gap-xs rounded-pill border border-edge bg-transparent px-md text-[13px] font-medium text-ink hover:bg-wash focus-ring self-start md:self-auto"
            >
              <Archive className="h-4 w-4" strokeWidth={2} />
              {showArchived ? "Hide archived" : `Show archived (${archivedLists.length})`}
            </a>
          )}
          <button
            type="button"
            onClick={actions.openCreateModal}
            className="flex h-11 items-center gap-sm self-start rounded-pill bg-primary px-md text-[14px] font-medium text-seal-ink hover:bg-primary-hover focus-ring md:self-auto"
          >
            <Plus className="h-4 w-4" strokeWidth={2} />
            New wine list
          </button>
        </div>
      </header>

      {actions.error && deleteTarget === null && (
        <div
          role="alert"
          className="mb-md flex items-start justify-between gap-sm rounded-md border border-risk-ink/30 bg-risk-wash px-sm py-xs text-[13px] text-risk-ink"
        >
          <span>{actions.error}</span>
          <button
            type="button"
            onClick={actions.dismissError}
            aria-label="Dismiss error"
            className="-mr-2xs flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-pill text-risk-ink/70 hover:bg-risk-wash hover:text-risk-ink focus-ring"
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
              onClick={actions.openCreateModal}
              className="inline-flex h-11 items-center gap-sm rounded-pill bg-primary px-md text-[14px] font-medium text-seal-ink hover:bg-primary-hover focus-ring"
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
                onClick={actions.openCreateModal}
                className="flex flex-col items-center justify-center gap-sm rounded-card border border-dashed border-rule-strong p-xl text-center text-grey transition-colors hover:border-accent hover:text-accent"
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
              <h2 className="mb-md font-serif text-[20px] text-grey">
                Archived
              </h2>
              <div className="grid gap-md md:grid-cols-[repeat(auto-fill,minmax(280px,1fr))]">
                {archivedLists.map(renderCard)}
              </div>
            </div>
          )}

          {/* All lists are archived, none active */}
          {lists.length === 0 && !showArchived && archivedLists.length > 0 && (
            <div className="flex flex-col items-center justify-center rounded-card border border-dashed border-rule-strong bg-wash px-lg py-3xl text-center">
              <Archive
                className="mb-md h-10 w-10 text-grey"
                strokeWidth={1.5}
              />
              <p className="text-[15px] font-medium text-ink">
                All wine lists are archived
              </p>
              <p className="mt-xs text-[13px] text-grey">
                Restore them or create a new one.
              </p>
              <Link
                href="/lists?show_archived=1"
                className="mt-lg inline-flex h-11 items-center gap-sm rounded-pill border border-edge bg-transparent px-md text-[13px] font-medium text-ink hover:bg-wash focus-ring"
              >
                <Archive className="h-4 w-4" strokeWidth={2} />
                Show archived lists
              </Link>
            </div>
          )}
        </>
      )}

      {/* Create modal */}
      {actions.showModal && (
        <CreateListModal
          newName={actions.newName}
          setNewName={actions.changeNewName}
          newDescription={actions.newDescription}
          setNewDescription={actions.changeNewDescription}
          creating={actions.creating}
          error={actions.createError}
          onClose={actions.closeCreateModal}
          onCreate={actions.createList}
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
        busy={actions.isDeleteBusy}
        onClose={actions.dismissDeleteTarget}
        onConfirm={actions.deleteList}
      >
        {actions.error && (
          <p
            role="alert"
            className="rounded-md border border-risk-ink/30 bg-risk-wash px-sm py-xs text-[13px] text-risk-ink"
          >
            {actions.error}
          </p>
        )}
      </ActionDialog>
    </section>
  );
}
