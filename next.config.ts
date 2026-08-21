import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import path from "node:path";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  serverExternalPackages: ["puppeteer", "@anthropic-ai/sdk"],
  turbopack: {
    root: path.resolve(__dirname),
  },
  /**
   * v5 IA redesign (.council/specs/2026-04-24-ux-ia-redesign.md):
   * old route paths redirect to new ones for at least 90 days so any
   * bookmarked URL keeps working. permanent: false means 307 (so
   * search engines don't aggressively cache the redirect — we want
   * room to revisit if anything misbehaves).
   *
   * Renames:
   *   /scanner   → /scan
   *   /dashboard → /insights
   *   /wine-list → /lists
   *
   * Consolidations (Phase 2 — single-screen Cellar absorbs these):
   *   /pour         → /cellar
   *   /availability → /cellar
   *   /reconcile    → /cellar
   */
  async redirects() {
    return [
      // Renames
      { source: "/scanner", destination: "/scan", permanent: false },
      { source: "/scanner/:path*", destination: "/scan/:path*", permanent: false },
      { source: "/dashboard", destination: "/insights", permanent: false },
      { source: "/dashboard/:path*", destination: "/insights/:path*", permanent: false },
      { source: "/wine-list", destination: "/lists", permanent: false },
      { source: "/wine-list/:path*", destination: "/lists/:path*", permanent: false },
      // Consolidations into Cellar
      { source: "/pour", destination: "/cellar", permanent: false },
      { source: "/pour/:path*", destination: "/cellar", permanent: false },
      { source: "/availability", destination: "/cellar", permanent: false },
      { source: "/availability/:path*", destination: "/cellar", permanent: false },
      { source: "/reconcile", destination: "/cellar", permanent: false },
      { source: "/reconcile/:path*", destination: "/cellar", permanent: false },
    ];
  },
};

/**
 * BND-032 / INT-010 — Sentry build-time wrapper.
 *
 * `authToken` drives source-map uploads at build time — missing token
 * means no upload (build still succeeds). Add SENTRY_AUTH_TOKEN to
 * Railway service variables + local .env.local when you want
 * de-minified stack traces in Sentry Issues.
 *
 * `tunnelRoute` creates a proxy API route at /monitoring so ad-blockers
 * and tracking-protection extensions can't silently drop Sentry events.
 * The src/proxy.ts matcher is updated to let this path through.
 *
 * `disableLogger` and `automaticVercelMonitors` are webpack-only and
 * Terroir runs on Turbopack — including them produces deprecation
 * warnings at every boot.
 */
export default withSentryConfig(nextConfig, {
  org: "zero-sum-nutrition",
  project: "terroir",
  authToken: process.env.SENTRY_AUTH_TOKEN,
  widenClientFileUpload: true,
  tunnelRoute: "/monitoring",
  silent: !process.env.CI,
});
