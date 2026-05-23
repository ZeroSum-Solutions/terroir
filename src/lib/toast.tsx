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

export function ToastProvider({ children }) {
  var nid = useRef(0);
  var [items, setItems] = useState([]);

  var add = useCallback(function(text, tone) {
    var id = nid.current++;
    setItems(function(prev) { return prev.concat({ id, text, tone }); });
    setTimeout(function() {
      setItems(function(prev) { return prev.filter(function(t) { return t.id !== id; }); });
    }, 5000);
  }, []);

  var toast = useCallback(function(text, tone) { add(text, tone || "success"); }, [add]);
  var success = useCallback(function(text) { add(text, "success"); }, [add]);
  var error = useCallback(function(text) { add(text, "error"); }, [add]);

  var ctx = { toast, success, error };

  return (
    <ToastCTX.Provider value={ctx}>
      {children}
      <ToastContainer items={items} />
    </ToastCTX.Provider>
  );
}

export function useToast() {
  var ctx = useContext(ToastCTX);
  if (!ctx) {
    throw new Error("useToast must be used inside a ToastProvider");
  }
  return ctx;
}

function ToastContainer({  items  }) {
  if (items.length === 0) return null;
  return (
    <div
      aria-live="polite"
      className={cn(
        "fixed inset-x-md z-50 mx-auto max-w-[420px]",
        "bottom-[88px] md:bottom-lg",
      )}
    >
      <div className="flex flex-col gap-xs">
        {items.map(function(t) {
          return (
            <div
              key={t.id}
              role="alert"
              className={cn(
                "flex items-center gap-sm rounded-md px-md py-sm text-[14px] shadow-lg",
                "animate-[toast-in_0.2s ease-out]",
                t.tone === "success" && "bg-surface-inverse text-white",
                t.tone === "error" && "bg-danger text-white",
              )}
            >
              {t.tone === "success" && (
                <Check className="h-4 w-4 text-success shrink-0" strokeWidth={2.25} />
              )}
              {t.tone === "error" && (
                <AlertTriangle className="h-4 w-4 shrink-0" strokeWidth={2.25} />
              )}
              <span className="flex-1">{t.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}