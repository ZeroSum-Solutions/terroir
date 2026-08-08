/**
 * New wine-enrichment requests stay on the synchronous path until the web
 * rollout is explicitly enabled after the invoice-OCR soak dependency.
 */
export function isWineEnrichmentWorkerEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.WINE_ENRICHMENT_WORKER_ENABLED === "1";
}

/**
 * Handler registration is independently gated so source-ready worker code can
 * be deployed without accepting jobs before its dependency is satisfied.
 */
export function isWineEnrichmentHandlerEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.WINE_ENRICHMENT_HANDLER_ENABLED === "1";
}
