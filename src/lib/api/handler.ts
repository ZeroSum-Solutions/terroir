import * as Sentry from "@sentry/nextjs";
import { Errors } from "./errors";

export async function withApiHandler(
  operation: () => Response | Promise<Response>,
): Promise<Response> {
  try {
    return await operation();
  } catch (error) {
    try {
      Sentry.captureException(error);
    } catch {
      // Error reporting must never replace the redacted client response.
    }
    return Errors.internal();
  }
}
