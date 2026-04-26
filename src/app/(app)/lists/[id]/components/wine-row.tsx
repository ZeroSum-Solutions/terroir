"use client";

import { useState } from "react";
import { GripVertical, MoreHorizontal, Trash2 } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import { ML_PER_OZ } from "@/lib/units";

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
  // BND-038: pour tracking per wine-list-item.
  glass_pour_ml: number | null;
  pour_size_mode: "fixed" | "picker";
  tasting_note: string | null;
  // ARCH-017: is_available deprecated. Not written, not read
  // by the editor. Omitted from the type to keep it from drifting
  // back into the PATCH payload.
  wines: Wine;
};

type PourField = "glass_pour_ml" | "pour_size_mode";
type PourValue = number | "fixed" | "picker" | null;

interface SortableWineRowProps {
  item: ListItem;
  onDelete: (id: string) => void;
  onPriceChange: (id: string, field: "glass_price" | "bottle_price", value: number | null) => void;
  onPourChange: (id: string, field: PourField, value: PourValue) => void;
}

interface WineRowProps {
  item: ListItem;
  onDelete: (id: string) => void;
  onPriceChange: (id: string, field: "glass_price" | "bottle_price", value: number | null) => void;
  onPourChange: (id: string, field: PourField, value: PourValue) => void;
  dragHandleProps?: Record<string, unknown>;
}

interface PriceInputProps {
  value: number | null;
  onChange: (v: number | null) => void;
  muted?: boolean;
}

function formatPrice(n: number | null) {
  if (n == null) return "—";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

export function PriceInput({ value, onChange, muted }: PriceInputProps) {
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

/**
 * BND-038: compact per-wine pour config. An integer ml input with an
 * "≈ X.X oz" hint + a Fixed/Picker radio toggle. The radios disable
 * when ml is blank (pour tracking is off). Renders identically on
 * desktop and mobile — the parent row places it in the right slot.
 */
function PourConfigRow({
  item,
  onPourChange,
}: {
  item: ListItem;
  onPourChange: WineRowProps["onPourChange"];
}) {
  const pour = item.glass_pour_ml;
  const ozHint = pour != null ? `≈ ${(pour / ML_PER_OZ).toFixed(1)} oz` : "";
  const tracked = pour != null;
  const nameRadio = `pour-mode-${item.id}`;

  return (
    <div className="flex flex-wrap items-center gap-sm text-[12px] text-ink-muted">
      <label className="flex items-center gap-xs">
        <span className="shrink-0">Pour</span>
        <input
          type="number"
          min={1}
          // Matches the API's Zod cap in /api/wine-list-items/[id].
          // A 2L pour is already physically absurd; 20L would be a
          // silent 400 from the server.
          max={2000}
          value={pour ?? ""}
          onChange={(e) => {
            const v = e.target.value.trim();
            if (v === "") {
              onPourChange(item.id, "glass_pour_ml", null);
              return;
            }
            const n = Number(v);
            if (!Number.isFinite(n) || n <= 0) return;
            onPourChange(
              item.id,
              "glass_pour_ml",
              Math.max(1, Math.min(2000, Math.round(n))),
            );
          }}
          placeholder="148"
          aria-label={`Pour size in ml for ${item.wines.name}`}
          className="h-[28px] w-[64px] rounded-sm border border-border bg-white px-xs text-right font-mono text-[12px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
        />
        <span className="shrink-0 text-[11px] text-ink-subtle">ml</span>
        {ozHint && (
          <span className="shrink-0 text-[11px] text-ink-subtle">{ozHint}</span>
        )}
      </label>
      <fieldset
        className={cn(
          "flex items-center gap-sm",
          !tracked && "pointer-events-none opacity-40",
        )}
      >
        <legend className="sr-only">Pour size mode</legend>
        <label className="flex items-center gap-xs">
          <input
            type="radio"
            name={nameRadio}
            checked={item.pour_size_mode === "fixed"}
            disabled={!tracked}
            onChange={() => onPourChange(item.id, "pour_size_mode", "fixed")}
          />
          Fixed
        </label>
        <label className="flex items-center gap-xs">
          <input
            type="radio"
            name={nameRadio}
            checked={item.pour_size_mode === "picker"}
            disabled={!tracked}
            onChange={() => onPourChange(item.id, "pour_size_mode", "picker")}
          />
          Picker
        </label>
      </fieldset>
    </div>
  );
}

export function WineRow({
  item,
  onDelete,
  onPriceChange,
  onPourChange,
  dragHandleProps,
}: WineRowProps) {
  const wine = item.wines;

  return (
    <>
      {/* Desktop row — grid + compact pour-config sub-row stacked below. */}
      <div className="group hidden border-b border-border transition-colors last:border-b-0 hover:bg-[#FBFAF6] md:block">
      <div className="grid grid-cols-[28px_1fr_80px_80px_36px] items-center px-lg py-sm">
        <div
          aria-label="Drag to reorder"
          className="cursor-grab text-ink-subtle opacity-0 transition-opacity group-hover:opacity-100"
          {...dragHandleProps}
        >
          <GripVertical className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
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
          onChange={(v) => onPriceChange(item.id, "glass_price", v)}
          muted
        />
        <PriceInput
          value={item.bottle_price}
          onChange={(v) => onPriceChange(item.id, "bottle_price", v)}
        />
        <button
          type="button"
          aria-label={`Remove ${item.wines.name}`}
          onClick={() => onDelete(item.id)}
          className="flex h-8 w-8 items-center justify-center rounded-sm text-ink-subtle opacity-0 transition-opacity hover:bg-surface-muted hover:text-danger group-hover:opacity-100"
        >
          <Trash2 className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
      {/* Desktop pour-config sub-row (offset to match the wine-name column). */}
      <div className="hidden border-t border-border/40 bg-surface-muted/30 px-lg pb-sm pt-xs md:grid md:grid-cols-[28px_1fr]">
        <div />
        <PourConfigRow item={item} onPourChange={onPourChange} />
      </div>
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
            aria-label={`Options for ${item.wines.name}`}
            onClick={() => onDelete(item.id)}
            className="ml-sm flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-ink-subtle hover:text-danger"
          >
            <MoreHorizontal className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
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
        {/* BND-038: mobile pour-config block. */}
        <div className="mt-sm border-t border-border/50 pt-sm">
          <div className="text-[11px] uppercase tracking-[0.06em] text-ink-subtle">
            Pour
          </div>
          <div className="mt-xs">
            <PourConfigRow item={item} onPourChange={onPourChange} />
          </div>
        </div>
      </div>
    </>
  );
}

export function SortableWineRow({
  item,
  onDelete,
  onPriceChange,
  onPourChange,
}: SortableWineRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });

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
        item={item}
        onDelete={onDelete}
        onPriceChange={onPriceChange}
        onPourChange={onPourChange}
        dragHandleProps={{ ...attributes, ...listeners }}
      />
    </div>
  );
}
