"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { wineTitle } from "@/lib/wine-display-name";
import type { WineListEditorItem as ListItem } from "../wine-list-editor.types";

/**
 * BND-169: inline click-to-edit for the list item's display name.
 * When name_override is set, it replaces the wine name on the public
 * list. When null, the original wine name is used.
 */
export function NameEditField({
  item,
  onNameChange,
  onDone,
}: {
  item: ListItem;
  onNameChange: (id: string, value: string | null) => void;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(item.name_override ?? "");

  const commit = () => {
    onDone();
    const trimmed = draft.trim();
    if (trimmed === "" || trimmed === item.wines.name) {
      // Blank or matching original → clear override (use wine name)
      onNameChange(item.id, null);
    } else {
      onNameChange(item.id, trimmed);
    }
  };

  return (
    <input
      autoFocus
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") onDone();
      }}
      placeholder={item.wines.name}
      aria-label={`Display name for ${item.wines.name}`}
      className="min-h-11 w-full rounded-md border-2 border-mark bg-surface px-xs py-2xs font-serif text-body-lg font-medium text-ink focus-ring"
    />
  );
}

/**
 * SD-12: PATCH /api/wine-list-items/{id} is owner/manager only, so a staff
 * member gets the display name as text rather than a control that 403s. The
 * override styling is kept — knowing a name has been customised is a read.
 */
export function NameEdit({
  item,
  onNameChange,
  canManage,
}: {
  item: ListItem;
  onNameChange: (id: string, value: string | null) => void;
  canManage: boolean;
}) {
  const [editing, setEditing] = useState(false);

  if (!canManage) {
    const displayName =
      item.name_override ??
      `${wineTitle(item.wines.producer, item.wines.name, ", ")}`;
    return (
      <span
        className={cn(
          "block min-h-11 px-xs py-2xs font-serif text-body-lg font-medium",
          item.name_override != null ? "text-accent italic" : "text-ink",
        )}
      >
        {displayName}
      </span>
    );
  }

  if (!editing) {
    const displayName =
      item.name_override ??
      `${wineTitle(item.wines.producer, item.wines.name, ", ")}`;
    const isOverridden = item.name_override != null;
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className={cn(
          "min-h-11 rounded-md border border-transparent px-xs py-2xs text-left transition-colors hover:border-rule hover:bg-surface",
          "font-serif text-body-lg font-medium",
          isOverridden ? "text-accent italic" : "text-ink",
        )}
        title={isOverridden ? "Custom display name (click to edit)" : "Click to set a custom display name"}
      >
        {isOverridden ? (
          <>
            <span className="line-through text-grey mr-xs text-ledger">{item.wines.name}</span>
            {displayName}
          </>
        ) : (
          displayName
        )}
      </button>
    );
  }

  return (
    <NameEditField
      item={item}
      onNameChange={onNameChange}
      onDone={() => setEditing(false)}
    />
  );
}
