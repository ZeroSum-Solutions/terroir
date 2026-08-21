"use client";

import { useEffect } from "react";
import { RouteDataError } from "@/components/route-data-state";

export default function OpenBottlesError({
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
      title="Open bottles couldn't be loaded"
      description="The request failed. Your open bottles have not been changed."
      onRetry={unstable_retry}
    />
  );
}
