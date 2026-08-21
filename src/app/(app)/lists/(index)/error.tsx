"use client";

import { useEffect } from "react";
import { RouteDataError } from "@/components/route-data-state";

export default function ListsError({
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
      title="Wine lists couldn't be loaded"
      description="The request failed. Your lists have not been changed."
      onRetry={unstable_retry}
    />
  );
}
