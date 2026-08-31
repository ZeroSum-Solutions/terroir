"use client";

import { useEffect } from "react";
import { RouteDataError } from "@/components/route-data-state";

export default function BinsError({
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
      title="Bins couldn't be loaded"
      description="The request failed. Your bins have not been changed."
      onRetry={unstable_retry}
    />
  );
}
