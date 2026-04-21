"use client";

/**
 * BND-032 / INT-010 — Sentry-aware global error boundary.
 *
 * App Router's last-resort error handler. Catches errors thrown in
 * the root layout or in the error tree itself (which a regular
 * error.tsx can't see). Reports to Sentry and renders a minimal
 * Terroir-branded fallback.
 *
 * Styling is inline because this component renders its own <html>
 * and <body> — Tailwind + the root-layout font classes don't apply
 * when the root layout itself crashed. Colors mirror DESIGN.md
 * tokens (--bg-primary, --text-primary, --accent).
 */

import * as Sentry from "@sentry/nextjs";
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
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          background: "#FAFAF8",
          color: "#1A1A1A",
          fontFamily:
            'Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "32px",
        }}
      >
        <div style={{ maxWidth: "420px" }}>
          <h1
            style={{
              fontFamily:
                '"Cormorant Garamond", Georgia, "Times New Roman", serif',
              fontSize: "28px",
              fontWeight: 500,
              margin: "0 0 12px",
              letterSpacing: "-0.01em",
            }}
          >
            Something went wrong.
          </h1>
          <p
            style={{
              fontSize: "15px",
              lineHeight: 1.5,
              color: "#6B6B6B",
              margin: "0 0 24px",
            }}
          >
            An unexpected error occurred. The team has been notified — if this
            keeps happening, reach out and share what you were doing.
          </p>
          {error.digest ? (
            <p
              style={{
                fontSize: "11px",
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: "#9A958C",
                fontFamily:
                  '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
                margin: "0 0 24px",
              }}
            >
              Reference: {error.digest}
            </p>
          ) : null}
          {/* global-error.tsx runs when the root layout has crashed.
              A full reload (plain <a>, not next/link) is the right
              recovery path — we explicitly want to throw away the
              broken client state. Next's no-html-link rule is for
              normal page navigation and doesn't apply here. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a
            href="/"
            style={{
              display: "inline-block",
              background: "#722F37",
              color: "white",
              padding: "10px 18px",
              borderRadius: "4px",
              fontSize: "14px",
              fontWeight: 500,
              textDecoration: "none",
            }}
          >
            Back to home
          </a>
        </div>
      </body>
    </html>
  );
}
