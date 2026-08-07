import type { JobHandlers } from "./types.ts";

/**
 * TER-021C owns the worker control plane. Business handlers are registered by
 * TER-021E/F/G before their corresponding enqueue paths are enabled.
 */
export function createJobHandlers(): JobHandlers {
  return {};
}
