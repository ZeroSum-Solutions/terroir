"use client";

import { ToastProvider } from "@/lib/toast";

export function ToastWrapper({ children }: { children: React.ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}