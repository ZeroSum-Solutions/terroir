/**
 * New PDF work remains synchronous unless the operator explicitly opts in.
 * Only the literal value `1` enables enqueueing, so missing, misspelled, or
 * inherited values fail back to the proven synchronous path.
 */
export function isPdfWorkerEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.PDF_WORKER_ENABLED === "1";
}
