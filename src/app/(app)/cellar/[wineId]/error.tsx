"use client";

import { useEffect } from "react";
import { RouteDataError } from "@/components/route-data-state";

export default function WineDetailError({
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
      title="This wine couldn't be loaded"
      description="The request failed. The wine has not been changed."
      onRetry={unstable_retry}
    />
  );
}
