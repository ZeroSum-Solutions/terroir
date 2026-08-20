"use client";

import { Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LineItem, LineItemField } from "@/lib/scanner/types";
import {
  formatMoney,
  MoneyInput,
  QtyStepper,
  TextInput,
  VintageInput,
} from "./field-inputs";

interface MobileFieldProps {
  label: string;
  span?: boolean;
  children: React.ReactNode;
}

function MobileField({ label, span, children }: MobileFieldProps) {
  return (
    <div className={cn("flex flex-col gap-xs", span && "col-span-2")}>
      <dt className="text-caption font-medium uppercase tracking-[0.18em] text-grey">
        {label}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

interface LineItemCardProps {
  item: LineItem;
  isLow: (it: LineItem, f: LineItemField) => boolean;
  isEdited: (it: LineItem, f: LineItemField) => boolean;
  onUpdate: (id: string, field: LineItemField, value: string | number | null) => void;
  onRemove: (id: string) => void;
}

export function LineItemCard({
  item,
  isLow,
  isEdited,
  onUpdate,
  onRemove,
}: LineItemCardProps) {
  return (
    <article className="rounded-lg border border-hairline bg-white p-md">
      <header className="mb-md flex items-start justify-between gap-sm">
        <div className="min-w-0 flex-1">
          <TextInput
            value={item.name}
            low={isLow(item, "name")}
            edited={isEdited(item, "name")}
            onCommit={(v) => onUpdate(item.id, "name", v)}
            className="font-serif text-[17px] font-medium"
          />
          <div className="mt-2xs">
            <TextInput
              value={item.producer}
              low={isLow(item, "producer")}
              edited={isEdited(item, "producer")}
              onCommit={(v) => onUpdate(item.id, "producer", v)}
              className="text-[13px] text-ink-muted"
              label="Producer"
            />
          </div>
        </div>
        <button
          type="button"
          aria-label={`Remove ${item.name}`}
          onClick={() => onRemove(item.id)}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-pill text-grey hover:bg-bridge-surface hover:text-primary"
        >
          <Trash2 className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
        </button>
      </header>

      <dl className="grid grid-cols-2 gap-x-md gap-y-sm">
        <MobileField label="Vintage">
          <VintageInput
            value={item.vintage}
            low={isLow(item, "vintage")}
            edited={isEdited(item, "vintage")}
            onCommit={(v) => onUpdate(item.id, "vintage", v)}
          />
        </MobileField>
        <MobileField label="Varietal">
          <TextInput
            value={item.varietal}
            low={isLow(item, "varietal")}
            edited={isEdited(item, "varietal")}
            onCommit={(v) => onUpdate(item.id, "varietal", v)}
          />
        </MobileField>
        <MobileField label="Region" span>
          <TextInput
            value={item.region}
            low={isLow(item, "region")}
            edited={isEdited(item, "region")}
            onCommit={(v) => onUpdate(item.id, "region", v)}
          />
        </MobileField>
        <MobileField label="Quantity">
          <div className="flex">
            <QtyStepper
              value={item.qty}
              onChange={(v) => onUpdate(item.id, "qty", v)}
            />
          </div>
        </MobileField>
        <MobileField label="Unit cost">
          <MoneyInput
            value={item.unitCost}
            low={isLow(item, "unitCost")}
            edited={isEdited(item, "unitCost")}
            onCommit={(v) => onUpdate(item.id, "unitCost", v)}
          />
        </MobileField>
      </dl>

      <footer className="mt-md flex items-center justify-between border-t border-hairline pt-sm">
        <span className="text-[12px] text-grey">Line total</span>
        <span className="font-mono text-[14px] font-medium text-ink tabular">
          ${formatMoney(item.qty * item.unitCost)}
        </span>
      </footer>
    </article>
  );
}
