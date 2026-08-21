"use client";

import { useEffect } from "react";
import { RouteDataError } from "@/components/route-data-state";

export default function TeamError({
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
      title="Team couldn't be loaded"
      description="The request failed. Your team has not been changed."
      onRetry={unstable_retry}
    />
  );
}
