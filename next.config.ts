import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import path from "node:path";

const nextConfig: NextConfig = {
  serverExternalPackages: ["puppeteer", "@anthropic-ai/sdk"],
  turbopack: {
    root: path.resolve(__dirname),
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
