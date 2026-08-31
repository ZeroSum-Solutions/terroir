"use client";

import { useEffect } from "react";
import { RouteDataError } from "@/components/route-data-state";

export default function AtlasError({
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
      title="Atlas couldn't be loaded"
      description="The request failed. Your cellar has not been changed."
      onRetry={unstable_retry}
    />
  );
}
