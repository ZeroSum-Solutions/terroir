import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
}

export function IconButton({
  label,
  className,
  children,
  type = "button",
  ...button
}: IconButtonProps) {
  return (
    <button
      {...button}
      type={type}
      aria-label={label}
      className={cn(
        "inline-flex min-h-11 min-w-11 items-center justify-center",
        className,
      )}
    >
      {children}
    </button>
  );
}
