import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface FieldA11yProps {
  id: string;
  "aria-describedby": string | undefined;
  "aria-invalid": true | undefined;
  "aria-required": true | undefined;
}

interface FieldProps {
  id: string;
  label: string;
  description?: string;
  error?: string | null;
  required?: boolean;
  srOnlyLabel?: boolean;
  className?: string;
  labelClassName?: string;
  children: (a11y: FieldA11yProps) => ReactNode;
}

export function Field({
  id,
  label,
  description,
  error,
  required = false,
  srOnlyLabel = false,
  className,
  labelClassName,
  children,
}: FieldProps) {
  const describedBy = [
    description ? `${id}-description` : null,
    error ? `${id}-error` : null,
  ]
    .filter(Boolean)
    .join(" ") || undefined;

  return (
    <div className={className}>
      <label
        htmlFor={id}
        className={cn(
          "text-caption font-medium uppercase tracking-[0.18em] text-grey",
          srOnlyLabel && "sr-only",
          labelClassName,
        )}
      >
        {label}
      </label>
      {description ? (
        <p id={`${id}-description`} className="mt-2xs text-[12px] text-grey">
          {description}
        </p>
      ) : null}
      {children({
        id,
        "aria-describedby": describedBy,
        "aria-invalid": error ? true : undefined,
        "aria-required": required ? true : undefined,
      })}
      {error ? (
        <p
          id={`${id}-error`}
          role="alert"
          className="mt-2xs text-ledger text-risk-ink"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
