"use client";

import { AlertTriangle, Minus, Plus } from "lucide-react";
import { useId, useState } from "react";
import { Field, type FieldA11yProps } from "@/components/field";
import { cn } from "@/lib/utils";

export function formatMoney(n: number) {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

const FIELD_WRAP =
  "relative flex w-full items-center rounded-sm border border-transparent bg-transparent px-sm py-xs transition-colors focus-within:border-accent focus-within:bg-surface focus-ring hover:border-hairline hover:bg-surface";

interface FieldWrapProps {
  low?: boolean;
  edited?: boolean;
  invalid?: boolean;
  children: React.ReactNode;
}

export function FieldWrap({ low, edited, invalid, children }: FieldWrapProps) {
  return (
    <div
      className={cn(
        FIELD_WRAP,
        low && "border-l-[3px] border-l-primary bg-risk-wash/60",
        edited && !low && "bg-ready-wash/40",
        // DESIGN.md — State: the error row is a solid `edge` boundary on the
        // risk wash, not a tint you have to already know about.
        invalid && "border-edge bg-risk-wash",
      )}
    >
      {children}
      {low && (
        <AlertTriangle
          className="ml-xs h-4 w-4 shrink-0 text-accent"
          strokeWidth={2}
          aria-label="Needs review"
        />
      )}
    </div>
  );
}

/**
 * The message a bare (label-less) field would otherwise have nowhere to put.
 * `Field` owns this when a caller supplies an id and label; the desktop scan
 * table supplies neither, and used to get no error at all.
 */
function BareField({
  error,
  errorId,
  children,
}: {
  error: string | null;
  errorId: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      {children}
      {error !== null && (
        <p id={errorId} role="alert" className="mt-3xs px-sm text-ledger text-risk-ink">
          {error}
        </p>
      )}
    </div>
  );
}

interface TextInputProps {
  id?: string;
  label?: string;
  value: string;
  low?: boolean;
  edited?: boolean;
  onCommit: (v: string) => void;
  className?: string;
  srOnlyLabel?: boolean;
}

export function TextInput({
  value,
  low,
  edited,
  onCommit,
  className,
  label,
  id,
  srOnlyLabel = false,
}: TextInputProps) {
  const [val, setVal] = useState(value);
  const [prevProp, setPrevProp] = useState(value);
  if (value !== prevProp) {
    setPrevProp(value);
    setVal(value);
  }
  const input = (a11y?: FieldA11yProps) => (
    <FieldWrap low={low} edited={edited}>
      <input
        {...a11y}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={() => val !== value && onCommit(val)}
        aria-label={a11y ? undefined : label}
        className={cn(
          "min-h-11 w-full bg-transparent text-[14px] text-ink outline-none",
          className,
        )}
      />
    </FieldWrap>
  );

  return id && label ? (
    <Field id={id} label={label} srOnlyLabel={srOnlyLabel}>
      {(a11y) => input(a11y)}
    </Field>
  ) : (
    input()
  );
}

interface VintageInputProps {
  id?: string;
  label?: string;
  value: number | null;
  low?: boolean;
  edited?: boolean;
  onCommit: (v: number | null) => void;
  srOnlyLabel?: boolean;
}

export function VintageInput({
  value,
  low,
  edited,
  onCommit,
  id,
  label,
  srOnlyLabel = false,
}: VintageInputProps) {
  const [val, setVal] = useState(value === null ? "NV" : String(value));
  const [error, setError] = useState<string | null>(null);
  const [prevProp, setPrevProp] = useState(value);
  if (value !== prevProp) {
    setPrevProp(value);
    setVal(value === null ? "NV" : String(value));
    setError(null);
  }
  const errorId = useId();
  const commit = () => {
    const trimmed = val.trim().toUpperCase();
    if (!trimmed || trimmed === "NV") {
      setError(null);
      return onCommit(null);
    }
    const n = parseInt(trimmed, 10);
    if (!Number.isFinite(n)) {
      // Validation used to be suppressed without an `id`, because there was
      // nowhere to render the message — so the desktop scan table, which
      // passes neither id nor label, silently coerced "twenty-ten" to NV
      // while the mobile cards rejected it. An error state reachable on one
      // viewport and not the other is a data-integrity bug, not a styling
      // one (DESIGN.md — State).
      setError("Enter a year or NV.");
      return;
    }
    setError(null);
    onCommit(n);
  };
  const input = (a11y?: FieldA11yProps) => (
    <FieldWrap low={low} edited={edited} invalid={error !== null}>
      <input
        // The bare fallbacks come first so Field's own ids win when it wraps
        // this input, and stand on their own when nothing does.
        aria-invalid={error !== null || undefined}
        aria-describedby={error !== null ? errorId : undefined}
        {...a11y}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={commit}
        inputMode="numeric"
        aria-label={a11y ? undefined : "Vintage"}
        className="min-h-11 w-full bg-transparent font-mono text-[13px] text-ink outline-none"
      />
    </FieldWrap>
  );

  return id && label ? (
    <Field id={id} label={label} error={error} srOnlyLabel={srOnlyLabel}>
      {(a11y) => input(a11y)}
    </Field>
  ) : (
    <BareField error={error} errorId={errorId}>
      {input()}
    </BareField>
  );
}

interface MoneyInputProps {
  id?: string;
  label?: string;
  value: number;
  low?: boolean;
  edited?: boolean;
  onCommit: (v: number) => void;
  srOnlyLabel?: boolean;
}

export function MoneyInput({
  value,
  low,
  edited,
  onCommit,
  id,
  label,
  srOnlyLabel = false,
}: MoneyInputProps) {
  const [val, setVal] = useState(value.toFixed(2));
  const [error, setError] = useState<string | null>(null);
  const [prevProp, setPrevProp] = useState(value);
  if (value !== prevProp) {
    setPrevProp(value);
    setVal(value.toFixed(2));
    setError(null);
  }
  const errorId = useId();
  const commit = () => {
    const n = parseFloat(val.replace(/,/g, ""));
    if (!Number.isFinite(n)) {
      // Same reasoning as VintageInput: the message is shown whether or not
      // the caller supplied an id.
      setError("Enter a valid amount.");
      return;
    }
    setError(null);
    if (n !== value) onCommit(n);
  };
  const input = (a11y?: FieldA11yProps) => (
    <FieldWrap low={low} edited={edited} invalid={error !== null}>
      <span className="mr-2xs font-mono text-[13px] text-ink-subtle">$</span>
      <input
        aria-invalid={error !== null || undefined}
        aria-describedby={error !== null ? errorId : undefined}
        {...a11y}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={commit}
        inputMode="decimal"
        aria-label={a11y ? undefined : "Unit cost"}
        className="min-h-11 w-full bg-transparent text-right font-mono text-[13px] font-medium text-ink outline-none"
      />
    </FieldWrap>
  );

  return id && label ? (
    <Field id={id} label={label} error={error} srOnlyLabel={srOnlyLabel}>
      {(a11y) => input(a11y)}
    </Field>
  ) : (
    <BareField error={error} errorId={errorId}>
      {input()}
    </BareField>
  );
}

interface QtyStepperProps {
  value: number;
  onChange: (v: number) => void;
}

export function QtyStepper({ value, onChange }: QtyStepperProps) {
  return (
    <div className="inline-flex items-center overflow-hidden rounded-pill border border-hairline bg-surface">
      <button
        type="button"
        aria-label="Decrease quantity"
        onClick={() => onChange(Math.max(1, value - 1))}
        className="flex h-11 w-11 items-center justify-center text-ink-muted hover:text-ink focus-ring"
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
        className="flex h-11 w-11 items-center justify-center text-ink-muted hover:text-ink focus-ring"
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
        "px-sm py-sm text-left text-caption font-medium uppercase tracking-[0.18em] text-grey",
        className,
      )}
    >
      {children}
    </th>
  );
}
