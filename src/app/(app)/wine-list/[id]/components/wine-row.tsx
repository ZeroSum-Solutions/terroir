"use client";

import { useState } from "react";
import { GripVertical, MoreHorizontal, Trash2 } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";

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

interface SortableWineRowProps {
  item: ListItem;
  onDelete: (id: string) => void;
  onPriceChange: (id: string, field: "glass_price" | "bottle_price", value: number | null) => void;
}

interface WineRowProps {
  item: ListItem;
  onDelete: (id: string) => void;
  onPriceChange: (id: string, field: "glass_price" | "bottle_price", value: number | null) => void;
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

export function WineRow({ item, onDelete, onPriceChange, dragHandleProps }: WineRowProps) {
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
          onChange={(v) => onPriceChange(item.id, "glass_price", v)}
          muted
        />
        <PriceInput
          value={item.bottle_price}
          onChange={(v) => onPriceChange(item.id, "bottle_price", v)}
        />
        <button
          type="button"
          onClick={() => onDelete(item.id)}
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
            onClick={() => onDelete(item.id)}
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

export function SortableWineRow({ item, onDelete, onPriceChange }: SortableWineRowProps) {
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
        dragHandleProps={{ ...attributes, ...listeners }}
      />
    </div>
  );
}
