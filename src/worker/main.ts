import { close, createWorkerHealthServer, listen } from "./health-server.ts";
import { parseWorkerConfig } from "./config.ts";
import { createJobHandlers } from "./handlers.ts";
import { WorkerRuntime } from "./runtime.ts";
import {
  createSupabaseJobStore,
  createWorkerSupabaseClient,
} from "./supabase-job-store.ts";
import { createWorkerTelemetry } from "./telemetry.ts";

const config = parseWorkerConfig();
const telemetry = createWorkerTelemetry(config);
const client = createWorkerSupabaseClient(
  config.supabaseUrl,
  config.serviceRoleKey,
);
const runtime = new WorkerRuntime(
  config,
  createSupabaseJobStore(client),
  createJobHandlers(),
  telemetry,
);
const server = createWorkerHealthServer(runtime);

let shutdownPromise: Promise<void> | null = null;

async function shutdown(signal: string): Promise<void> {
  shutdownPromise ??= (async () => {
    telemetry.emit("worker_signal", { signal, status: "received" });
    await runtime.stop(signal);
    await close(server);
    telemetry.emit("worker_stopped", { status: "stopped" });
  })();
  return shutdownPromise;
}

function shutdownAndExit(signal: string, exitCode: number): void {
  void shutdown(signal).finally(() => {
    setTimeout(() => process.exit(exitCode), 0);
  });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => shutdownAndExit(signal, 0));
}

process.on("unhandledRejection", () => {
  telemetry.emit("worker_process_error", {
    error_code: "unhandled_rejection",
    outcome: "failed",
  });
  shutdownAndExit("unhandled_rejection", 1);
});

process.on("uncaughtException", () => {
  telemetry.emit("worker_process_error", {
    error_code: "uncaught_exception",
    outcome: "failed",
  });
  shutdownAndExit("uncaught_exception", 1);
});

try {
  await listen(server, config.port);
  telemetry.emit("worker_health_listening", { status: "listening" });
  await runtime.run();
} catch {
  telemetry.emit("worker_start_failed", {
    error_code: "worker_start_failed",
    outcome: "failed",
  });
  await shutdown("startup_failure");
  process.exitCode = 1;
}
