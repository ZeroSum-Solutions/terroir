import * as Sentry from "@sentry/nextjs";
import { Errors } from "./errors";
import {
  applyApiRequestHeaders,
  runWithApiRequestContext,
} from "./request-context";

export async function withApiHandler(
  operation: () => Response | Promise<Response>,
): Promise<Response> {
  return runWithApiRequestContext(async () => {
    try {
      return applyApiRequestHeaders(await operation());
    } catch (error) {
      try {
        Sentry.captureException(error);
      } catch {
        // Error reporting must never replace the redacted client response.
      }
      return applyApiRequestHeaders(Errors.internal());
    }
  });
}
