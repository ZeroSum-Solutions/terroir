"use client";

import { createContext, useCallback, useContext, useState, useRef } from "react";
import { Check, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

type ToastTone = "success" | "error";

type ToastItem = {
  id: number;
  text: string;
  tone: ToastTone;
};

type ToastCtx = {
  toast: (text: string, tone?: ToastTone) => void;
  success: (text: string) => void;
  error: (text: string) => void;
};

const ToastCTX = createContext<ToastCtx | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const nid = useRef(0);
  const [items, setItems] = useState<ToastItem[]>([]);

  const add = useCallback((text: string, tone: ToastTone) => {
    const id = nid.current++;
    setItems((prev) => prev.concat({ id, text, tone }));
    setTimeout(() => {
      setItems((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  }, []);

  const toast = useCallback((text: string, tone?: ToastTone) => { add(text, tone || "success"); }, [add]);
  const success = useCallback((text: string) => { add(text, "success"); }, [add]);
  const error = useCallback((text: string) => { add(text, "error"); }, [add]);

  const ctx: ToastCtx = { toast, success, error };

  return (
    <ToastCTX.Provider value={ctx}>
      {children}
      <ToastContainer items={items} />
    </ToastCTX.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastCTX);
  if (!ctx) {
    throw new Error("useToast must be used inside a ToastProvider");
  }
  return ctx;
}

function ToastContainer({ items }: { items: ToastItem[] }) {
  if (items.length === 0) return null;
  return (
    <div
      aria-live="polite"
      className={cn(
        // `toast` sits above `dialog` on purpose: feedback about an action
        // must be visible over the surface that triggered it (DESIGN.md —
        // Layers). It used to share z-[var(--z-dialog)] with modals, so whether a
        // confirmation appeared depended on DOM order.
        "fixed inset-x-md z-[var(--z-toast)] mx-auto max-w-[420px]",
        "bottom-[calc(var(--chrome-tabbar-total)+var(--spacing-lg))] md:bottom-lg",
      )}
    >
      <div className="flex flex-col gap-xs">
        {items.map((t) => {
          return (
            <div
              key={t.id}
              // The container is aria-live="polite"; role="alert" is
              // assertive and contradicts it, so a success confirmation used
              // to interrupt a screen-reader user mid-sentence. Only errors
              // are alerts (DESIGN.md — State).
              role={t.tone === "error" ? "alert" : "status"}
              className={cn(
                "glass flex items-center gap-sm rounded-lg px-md py-sm text-[14px] text-ink",
                "animate-[toast-in_0.2s ease-out]",
              )}
            >
              {t.tone === "success" && (
                <Check className="h-4 w-4 text-sage-ink shrink-0" strokeWidth={2.25} />
              )}
              {t.tone === "error" && (
                <AlertTriangle className="h-4 w-4 text-primary shrink-0" strokeWidth={2.25} />
              )}
              <span className="flex-1">{t.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}