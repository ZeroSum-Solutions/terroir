"use client";

import { Trash2 } from "lucide-react";
import { IconButton } from "@/components/icon-button";
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
  span?: boolean;
  children: React.ReactNode;
}

function MobileField({ span, children }: MobileFieldProps) {
  return (
    <div className={cn("flex flex-col gap-xs", span && "col-span-2")}>
      {children}
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
            id={`line-${item.id}-name`}
            label="Wine name"
            value={item.name}
            low={isLow(item, "name")}
            edited={isEdited(item, "name")}
            onCommit={(v) => onUpdate(item.id, "name", v)}
            className="font-serif text-[17px] font-medium"
          />
          <div className="mt-2xs">
            <TextInput
              id={`line-${item.id}-producer`}
              value={item.producer}
              low={isLow(item, "producer")}
              edited={isEdited(item, "producer")}
              onCommit={(v) => onUpdate(item.id, "producer", v)}
              className="text-[13px] text-ink-muted"
              label="Producer"
            />
          </div>
        </div>
        <IconButton
          label={`Remove ${item.name}`}
          onClick={() => onRemove(item.id)}
          className="shrink-0 rounded-pill text-grey hover:bg-bridge-surface hover:text-primary"
        >
          <Trash2 className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
        </IconButton>
      </header>

      <div className="grid grid-cols-2 gap-x-md gap-y-sm">
        <MobileField>
          <VintageInput
            id={`line-${item.id}-vintage`}
            label="Vintage"
            value={item.vintage}
            low={isLow(item, "vintage")}
            edited={isEdited(item, "vintage")}
            onCommit={(v) => onUpdate(item.id, "vintage", v)}
          />
        </MobileField>
        <MobileField>
          <TextInput
            id={`line-${item.id}-varietal`}
            label="Varietal"
            value={item.varietal}
            low={isLow(item, "varietal")}
            edited={isEdited(item, "varietal")}
            onCommit={(v) => onUpdate(item.id, "varietal", v)}
          />
        </MobileField>
        <MobileField span>
          <TextInput
            id={`line-${item.id}-region`}
            label="Region"
            value={item.region}
            low={isLow(item, "region")}
            edited={isEdited(item, "region")}
            onCommit={(v) => onUpdate(item.id, "region", v)}
          />
        </MobileField>
        <MobileField>
          <div className="flex flex-col gap-xs">
            <span className="text-caption font-medium uppercase tracking-[0.18em] text-grey">
              Quantity
            </span>
            <QtyStepper
              value={item.qty}
              onChange={(v) => onUpdate(item.id, "qty", v)}
            />
          </div>
        </MobileField>
        <MobileField>
          <MoneyInput
            id={`line-${item.id}-unit-cost`}
            label="Unit cost"
            value={item.unitCost}
            low={isLow(item, "unitCost")}
            edited={isEdited(item, "unitCost")}
            onCommit={(v) => onUpdate(item.id, "unitCost", v)}
          />
        </MobileField>
      </div>

      <footer className="mt-md flex items-center justify-between border-t border-hairline pt-sm">
        <span className="text-[12px] text-grey">Line total</span>
        <span className="font-mono text-[14px] font-medium text-ink tabular">
          ${formatMoney(item.qty * item.unitCost)}
        </span>
      </footer>
    </article>
  );
}
