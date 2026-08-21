"use client";

import { useEffect } from "react";
import { RouteDataError } from "@/components/route-data-state";

export default function ReconciliationHistoryError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <RouteDataError
      title="Reconciliation history couldn't be loaded"
      description="The request failed. Your reconciliation history has not been changed."
      onRetry={unstable_retry}
    />
  );
}
