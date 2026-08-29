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
 * when the root layout itself crashed. Colors mirror the DESIGN.md
 * ("Terroir — Cantina") tokens and must be hand-synced when the
 * contract changes. Both modes are carried by the --ge-* vars below;
 * the init script re-applies a stored explicit choice because React
 * re-renders <html> here, dropping the boot script's data-theme.
 */

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

const themeInitScript = `try{var t=localStorage.getItem("terroir-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

const palette = `
:root{--ge-canvas:#F4F5F6;--ge-ink:#0B0D10;--ge-grey:#626B72;--ge-primary:#96122A;color-scheme:light}
[data-theme="dark"]{--ge-canvas:#07080A;--ge-ink:#EEF1F4;--ge-grey:#79838B;--ge-primary:#D01A3C;color-scheme:dark}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]):not([data-theme="dark"]){--ge-canvas:#07080A;--ge-ink:#EEF1F4;--ge-grey:#79838B;--ge-primary:#D01A3C;color-scheme:dark}}
`;

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          background: "var(--ge-canvas)",
          color: "var(--ge-ink)",
          fontFamily:
            'Archivo, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "32px",
        }}
      >
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <style dangerouslySetInnerHTML={{ __html: palette }} />
        <div style={{ maxWidth: "420px" }}>
          <h1
            style={{
              fontFamily:
                '"Bodoni Moda", Didot, Georgia, "Times New Roman", serif',
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
              color: "var(--ge-grey)",
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
                letterSpacing: "0.18em",
                textTransform: "uppercase",
                color: "var(--ge-grey)",
                fontFamily:
                  '"Courier Prime", ui-monospace, SFMono-Regular, monospace',
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
              background: "var(--ge-primary)",
              color: "#ffffff",
              padding: "12px 24px",
              borderRadius: "999px",
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
