"use client";

import { useEffect } from "react";
import { RouteDataError } from "@/components/route-data-state";

export default function CatalogueDetailError({
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
      title="This catalogue wine couldn't be loaded"
      description="The request failed. Nothing in your cellar has been changed."
      onRetry={unstable_retry}
    />
  );
}
