"use client";

/**
 * BND-032 / INT-010 — Sentry-aware global error boundary.
 *
 * App Router's last-resort error handler. Catches errors thrown in the
 * root layout or in the error tree itself (which a regular `error.tsx`
 * can't see). Reports to Sentry then renders Next.js's default error
 * page so the user sees something rather than a blank screen.
 */

import * as Sentry from "@sentry/nextjs";
import NextError from "next/error";
import { useEffect } from "react";

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html>
      <body>
        <NextError statusCode={0} />
      </body>
    </html>
  );
}
