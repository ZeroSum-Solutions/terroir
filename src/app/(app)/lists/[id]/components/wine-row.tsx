"use client";

import { useState } from "react";
import { WineThumb } from "@/components/wine-thumb";
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
  hero_image_url?: string | null;
  colour?: string | null;
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
  name_override: string | null;
  blurb: string | null;
  hidden: boolean;
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
  onNameChange: (id: string, value: string | null) => void;
  onBlurbChange: (id: string, value: string | null) => void;
  onHiddenChange: (id: string, value: boolean) => void;
}

interface WineRowProps {
  item: ListItem;
  onDelete: (id: string) => void;
  onPriceChange: (id: string, field: "glass_price" | "bottle_price", value: number | null) => void;
  onPourChange: (id: string, field: PourField, value: PourValue) => void;
  onNameChange: (id: string, value: string | null) => void;
  onBlurbChange: (id: string, value: string | null) => void;
  onHiddenChange: (id: string, value: boolean) => void;
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
          "min-h-11 w-full rounded-md border border-transparent px-xs py-2xs text-right font-mono text-[14px] transition-colors hover:border-rule hover:bg-surface",
          muted ? "text-grey" : "text-ink",
        )}
      >
        {formatPrice(value)}
      </button>
    );
  }

  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-xs top-1/2 -translate-y-1/2 font-mono text-[14px] text-grey">
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
        className="min-h-11 w-full rounded-md border-2 border-mark bg-surface py-2xs pl-md pr-xs text-right font-mono text-[14px] text-ink focus-ring"
      />
    </div>
  );
}

/**
 * BND-169: inline click-to-edit for the list item's display name.
 * When name_override is set, it replaces the wine name on the public
 * list. When null, the original wine name is used.
 */
function NameEdit({
  item,
  onNameChange,
}: {
  item: ListItem;
  onNameChange: (id: string, value: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.name_override ?? "");

  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed === "" || trimmed === item.wines.name) {
      // Blank or matching original → clear override (use wine name)
      onNameChange(item.id, null);
    } else {
      onNameChange(item.id, trimmed);
    }
  };

  if (!editing) {
    const displayName = item.name_override ?? `${item.wines.producer}, ${item.wines.name}`;
    const isOverridden = item.name_override != null;
    return (
      <button
        type="button"
        onClick={() => {
          setDraft(item.name_override ?? "");
          setEditing(true);
        }}
        className={cn(
          "min-h-11 rounded-md border border-transparent px-xs py-2xs text-left transition-colors hover:border-rule hover:bg-surface",
          "font-serif text-[17px] font-medium",
          isOverridden ? "text-accent italic" : "text-ink",
        )}
        title={isOverridden ? "Custom display name (click to edit)" : "Click to set a custom display name"}
      >
        {isOverridden ? (
          <>
            <span className="line-through text-grey mr-xs text-[12px]">{item.wines.name}</span>
            {displayName}
          </>
        ) : (
          displayName
        )}
      </button>
    );
  }

  return (
    <input
      autoFocus
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setEditing(false);
      }}
      placeholder={item.wines.name}
      className="min-h-11 w-full rounded-md border-2 border-mark bg-surface px-xs py-2xs font-serif text-[17px] font-medium text-ink focus-ring"
    />
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
    <div className="flex flex-wrap items-center gap-sm text-[12px] text-grey">
      <label className="flex min-h-11 items-center gap-xs">
        <span className="shrink-0">Pour</span>
        <input
          type="number"
          min={1}
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
          className="h-11 w-[64px] rounded-md border border-rule bg-surface px-xs text-right font-mono text-[12px] text-ink outline-none focus:border-accent focus-ring"
        />
        <span className="shrink-0 text-[11px] text-grey">ml</span>
        {ozHint && (
          <span className="shrink-0 text-[11px] text-grey">{ozHint}</span>
        )}
      </label>
      <fieldset
        className={cn(
          "flex items-center gap-sm",
          !tracked && "pointer-events-none opacity-40",
        )}
      >
        <legend className="sr-only">Pour size mode</legend>
        <label className="flex min-h-11 items-center gap-xs">
          <input
            type="radio"
            name={nameRadio}
            checked={item.pour_size_mode === "fixed"}
            disabled={!tracked}
            onChange={() => onPourChange(item.id, "pour_size_mode", "fixed")}
          />
          Fixed
        </label>
        <label className="flex min-h-11 items-center gap-xs">
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
  onNameChange,
  onBlurbChange,
  onHiddenChange,
  dragHandleProps,
}: WineRowProps) {
  const wine = item.wines;

  return (
    <>
      {/* Desktop row — grid + compact pour-config sub-row stacked below. */}
      <div className="group hidden border-b border-rule transition-colors last:border-b-0 hover:bg-wash md:block">
      <div className="grid grid-cols-[28px_40px_1fr_80px_80px_36px] items-center px-lg py-sm">
        <div
          aria-label="Drag to reorder"
          className="flex min-h-11 min-w-11 cursor-grab items-center justify-center text-grey opacity-0 transition-opacity group-hover:opacity-100"
          {...dragHandleProps}
        >
          <GripVertical className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
        </div>
        <WineThumb
          src={wine.hero_image_url}
          producer={wine.producer}
          name={wine.name}
          colour={wine.colour}
          size={32}
        />
        <div>
          <NameEdit item={item} onNameChange={onNameChange} />
          <div className="mt-2xs flex items-center gap-xs text-[12px] text-grey">
            <span className="font-mono text-grey">
              {wine.vintage ?? "NV"}
            </span>
            {wine.region && (
              <>
                <span className="text-grey">·</span>
                <span>{wine.region}</span>
              </>
            )}
            {wine.serving_temp_label && (
              <>
                <span className="text-grey">·</span>
                <span className="text-grey">{wine.serving_temp_min}–{wine.serving_temp_max}°F</span>
              </>
            )}
            {wine.drink_window_start && wine.drink_window_end && (
              <>
                <span className="text-grey">·</span>
                <span className="text-grey">Drink {wine.drink_window_start}–{wine.drink_window_end}</span>
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
          className="flex h-11 w-11 items-center justify-center rounded-pill text-grey opacity-0 transition-opacity hover:bg-risk-wash hover:text-risk-ink group-hover:opacity-100"
        >
          <Trash2 className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
      {/* Desktop pour-config sub-row (offset to match the wine-name column). */}
      <div className="hidden border-t border-rule/40 bg-wash/30 px-lg pb-sm pt-xs md:grid md:grid-cols-[28px_40px_1fr]">
        {/* Two spacers, one per leading column above (drag handle, thumbnail),
            so this sub-row stays aligned under the wine's name. */}
        <div />
        <div />
        <div className="min-w-0 space-y-xs">
          <PourConfigRow item={item} onPourChange={onPourChange} />
          {/* BND-170: blurb input */}
          <div className="flex min-w-0 items-start gap-sm">
            <textarea
              value={item.blurb ?? ""}
              onChange={(e) => onBlurbChange(item.id, e.target.value || null)}
              onBlur={(e) => { if (!e.target.value.trim()) onBlurbChange(item.id, null); }}
              placeholder="Add a note for guests (e.g., sommelier pick, pairing suggestion)"
              rows={2}
              className="min-h-11 min-w-0 flex-1 resize-none rounded-md border border-rule bg-surface px-xs py-1 text-[12px] text-ink outline-none placeholder:text-grey/50 focus:border-accent focus-ring"
            />
            {/* BND-171: hide toggle */}
            <button
              type="button"
              onClick={() => onHiddenChange(item.id, !item.hidden)}
              className={cn(
                "min-h-11 shrink-0 rounded-pill px-sm py-1 text-[10.5px] font-medium uppercase tracking-wide transition-colors",
                item.hidden ? "bg-risk-wash text-risk-ink" : "bg-surface-sunken text-ink-soft hover:text-ink"
              )}
              title={item.hidden ? "Hidden from public list" : "Visible on public list"}
            >
              {item.hidden ? "Hidden" : "Visible"}
            </button>
          </div>
        </div>
      </div>
      </div>

      {/* Mobile card */}
      <div className="border-b border-rule px-md py-md last:border-b-0 md:hidden">
        <div className="flex items-start justify-between gap-sm">
          <WineThumb
            src={wine.hero_image_url}
            producer={wine.producer}
            name={wine.name}
            colour={wine.colour}
            size={40}
          />
          <div className="min-w-0 flex-1">
            <NameEdit item={item} onNameChange={onNameChange} />
            <div className="mt-2xs flex flex-wrap items-center gap-xs text-[12px] text-grey">
              <span className="rounded-pill bg-surface-sunken px-sm py-2xs font-mono text-[11px] text-ink-soft">
                {wine.vintage ?? "NV"}
              </span>
              {wine.region && <span>{wine.region}</span>}
            </div>
            {(wine.serving_temp_label || wine.drink_window_start) && (
              <div className="mt-xs flex items-center gap-sm text-[11px] text-grey">
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
            className="ml-sm flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-pill text-grey hover:text-accent"
          >
            <MoreHorizontal className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
        <div className="mt-sm flex gap-lg">
          <div>
            <div className="text-caption uppercase text-grey">
              Glass
            </div>
            <div className="font-mono text-[14px] text-grey">
              {formatPrice(item.glass_price)}
            </div>
          </div>
          <div>
            <div className="text-caption uppercase text-grey">
              Bottle
            </div>
            <div className="font-mono text-[14px] text-ink">
              {formatPrice(item.bottle_price)}
            </div>
          </div>
        </div>
        {/* BND-038: mobile pour-config block. */}
        <div className="mt-sm border-t border-rule/50 pt-sm">
          <div className="text-caption uppercase text-grey">
            Pour
          </div>
          <div className="mt-xs">
            <PourConfigRow item={item} onPourChange={onPourChange} />
          </div>
        </div>
        {/* BND-170/171: blurb + hide toggle (mobile) */}
        <div className="mt-sm border-t border-rule/50 pt-sm">
          <div className="text-caption uppercase text-grey">
            Note
          </div>
          <textarea
            value={item.blurb ?? ""}
            onChange={(e) => onBlurbChange(item.id, e.target.value || null)}
            onBlur={(e) => { if (!e.target.value.trim()) onBlurbChange(item.id, null); }}
            placeholder="Sommelier pick, pairing suggestion..."
            rows={2}
            className="mt-xs w-full rounded-md border border-rule bg-surface px-xs py-1 text-[12px] text-ink resize-none outline-none focus:border-accent focus-ring placeholder:text-grey/50"
          />
          <button
            type="button"
            onClick={() => onHiddenChange(item.id, !item.hidden)}
            className={cn(
              "mt-xs min-h-11 rounded-pill px-sm py-xs text-[10.5px] font-medium uppercase tracking-wide transition-colors",
              item.hidden ? "bg-risk-wash text-risk-ink" : "bg-surface-sunken text-ink-soft hover:text-ink"
            )}
            title={item.hidden ? "Hidden from public list" : "Visible on public list"}
          >
            {item.hidden ? "Hidden from list" : "Visible on list"}
          </button>
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
  onNameChange,
  onBlurbChange,
  onHiddenChange,
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
        onNameChange={onNameChange}
        onBlurbChange={onBlurbChange}
        onHiddenChange={onHiddenChange}
        dragHandleProps={{ ...attributes, ...listeners }}
      />
    </div>
  );
}
