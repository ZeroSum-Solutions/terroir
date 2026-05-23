"use client";

import { ToastProvider } from "@/lib/toast";

export function ToastWrapper({ children }) {
  return <ToastProvider>{children}</ToastProvider>;
}