"use client";

import { AlertTriangle, Minus, Plus } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

export function formatMoney(n: number) {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

const FIELD_WRAP =
  "relative flex w-full items-center rounded-sm border border-transparent bg-transparent px-sm py-xs transition-colors focus-within:border-accent focus-within:bg-white focus-within:shadow-[0_0_0_3px_var(--color-accent-soft)] hover:border-border hover:bg-white";

interface FieldWrapProps {
  low?: boolean;
  edited?: boolean;
  children: React.ReactNode;
}

export function FieldWrap({ low, edited, children }: FieldWrapProps) {
  return (
    <div
      className={cn(
        FIELD_WRAP,
        low && "border-l-[3px] border-l-warning bg-warning-soft/60",
        edited && !low && "bg-success-soft/40",
      )}
    >
      {children}
      {low && (
        <AlertTriangle
          className="ml-xs h-4 w-4 shrink-0 text-warning"
          strokeWidth={2}
          aria-label="Needs review"
        />
      )}
    </div>
  );
}

interface TextInputProps {
  value: string;
  low?: boolean;
  edited?: boolean;
  onCommit: (v: string) => void;
  className?: string;
}

export function TextInput({
  value,
  low,
  edited,
  onCommit,
  className,
  label,
}: TextInputProps & { label?: string }) {
  const [val, setVal] = useState(value);
  const [prevProp, setPrevProp] = useState(value);
  if (value !== prevProp) {
    setPrevProp(value);
    setVal(value);
  }
  return (
    <FieldWrap low={low} edited={edited}>
      <input
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={() => val !== value && onCommit(val)}
        aria-label={label}
        className={cn(
          "w-full bg-transparent text-[14px] text-ink outline-none",
          className,
        )}
      />
    </FieldWrap>
  );
}

interface VintageInputProps {
  value: number | null;
  low?: boolean;
  edited?: boolean;
  onCommit: (v: number | null) => void;
}

export function VintageInput({
  value,
  low,
  edited,
  onCommit,
}: VintageInputProps) {
  const [val, setVal] = useState(value === null ? "NV" : String(value));
  const [prevProp, setPrevProp] = useState(value);
  if (value !== prevProp) {
    setPrevProp(value);
    setVal(value === null ? "NV" : String(value));
  }
  const commit = () => {
    const trimmed = val.trim().toUpperCase();
    if (!trimmed || trimmed === "NV") return onCommit(null);
    const n = parseInt(trimmed, 10);
    if (!Number.isFinite(n)) return onCommit(null);
    onCommit(n);
  };
  return (
    <FieldWrap low={low} edited={edited}>
      <input
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={commit}
        inputMode="numeric"
        aria-label="Vintage"
        className="w-full bg-transparent font-mono text-[13px] text-ink outline-none"
      />
    </FieldWrap>
  );
}

interface MoneyInputProps {
  value: number;
  low?: boolean;
  edited?: boolean;
  onCommit: (v: number) => void;
}

export function MoneyInput({
  value,
  low,
  edited,
  onCommit,
}: MoneyInputProps) {
  const [val, setVal] = useState(value.toFixed(2));
  const [prevProp, setPrevProp] = useState(value);
  if (value !== prevProp) {
    setPrevProp(value);
    setVal(value.toFixed(2));
  }
  const commit = () => {
    const n = parseFloat(val.replace(/,/g, ""));
    if (!Number.isFinite(n)) return;
    if (n !== value) onCommit(n);
  };
  return (
    <FieldWrap low={low} edited={edited}>
      <span className="mr-2xs font-mono text-[13px] text-ink-subtle">$</span>
      <input
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={commit}
        inputMode="decimal"
        aria-label="Unit cost"
        className="w-full bg-transparent text-right font-mono text-[13px] font-medium text-ink outline-none"
      />
    </FieldWrap>
  );
}

interface QtyStepperProps {
  value: number;
  onChange: (v: number) => void;
}

export function QtyStepper({ value, onChange }: QtyStepperProps) {
  return (
    <div className="inline-flex items-center rounded-sm border border-border bg-white">
      <button
        type="button"
        aria-label="Decrease quantity"
        onClick={() => onChange(Math.max(1, value - 1))}
        className="flex h-11 w-11 items-center justify-center text-ink-muted hover:text-ink md:h-9 md:w-9"
      >
        <Minus className="h-4 w-4" strokeWidth={2.25} aria-hidden="true" />
      </button>
      <span className="min-w-10 text-center font-mono text-[14px] font-medium text-ink tabular">
        {value}
      </span>
      <button
        type="button"
        aria-label="Increase quantity"
        onClick={() => onChange(value + 1)}
        className="flex h-11 w-11 items-center justify-center text-ink-muted hover:text-ink md:h-9 md:w-9"
      >
        <Plus className="h-4 w-4" strokeWidth={2.25} aria-hidden="true" />
      </button>
    </div>
  );
}

interface ThProps {
  children?: React.ReactNode;
  className?: string;
}

export function Th({ children, className }: ThProps) {
  return (
    <th
      scope="col"
      className={cn(
        "px-sm py-sm text-left text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle",
        className,
      )}
    >
      {children}
    </th>
  );
}
