import * as Sentry from "@sentry/nextjs";
import { Errors } from "./errors";

export async function withApiHandler(
  operation: () => Response | Promise<Response>,
): Promise<Response> {
  try {
    return await operation();
  } catch (error) {
    // The client only ever sees the redacted envelope below. Outside
    // production the server console gets the real error too: a local 500
    // with nothing in the terminal is undiagnosable, and that silence is
    // how "ANTHROPIC_API_KEY missing" hid behind a generic 500 in a demo
    // rehearsal. Production keeps its logs quiet and reports to Sentry.
    if (process.env.NODE_ENV !== "production") {
      console.error("[api] unhandled error", error);
    }
    try {
      Sentry.captureException(error);
    } catch {
      // Error reporting must never replace the redacted client response.
    }
    return Errors.internal();
  }
}
