"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { TEMPLATES, type Template } from "@/lib/wine-list/types";

interface TemplatePickerProps {
  current: string;
  onChange: (template: Template) => void;
  disabled?: boolean;
  ariaLabelledby?: string;
}

export function TemplatePicker({
  current,
  onChange,
  disabled,
  ariaLabelledby,
}: TemplatePickerProps) {
  return (
    <div
      role="group"
      aria-labelledby={ariaLabelledby}
      className="flex flex-col gap-2xs"
    >
      {TEMPLATES.map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => onChange(t)}
          disabled={disabled}
          aria-pressed={current === t}
          className={cn(
            "flex min-h-11 items-center justify-between rounded-pill px-sm py-xs text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25 disabled:pointer-events-none",
            current === t
              ? "bg-bridge-surface font-medium text-ink"
              : "text-ink-muted hover:bg-bridge-surface hover:text-ink",
          )}
        >
          <span>{t.charAt(0).toUpperCase() + t.slice(1)}</span>
          {current === t && (
            <Check
              className="h-3.5 w-3.5 text-primary"
              strokeWidth={2.5}
            />
          )}
        </button>
      ))}
    </div>
  );
}
