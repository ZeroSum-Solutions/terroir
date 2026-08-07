import { createServer, type Server } from "node:http";
import type { WorkerRuntime } from "./runtime.ts";

export function createWorkerHealthServer(
  runtime: Pick<WorkerRuntime, "snapshot">,
): Server {
  return createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    if (request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }
    const snapshot = runtime.snapshot();
    const statusCode = snapshot.status === "ready" ? 200 : 503;
    response.writeHead(statusCode, {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    });
    if (request.method === "HEAD") return response.end();
    response.end(
      JSON.stringify({
        service: "terroir-worker",
        readiness: snapshot.status,
        active_jobs: snapshot.activeJobs,
        accepting_jobs: snapshot.acceptingJobs,
        capacity: snapshot.capacity,
        registered_handlers: snapshot.registeredHandlers,
        database: {
          last_success_at: snapshot.lastDatabaseSuccessAt,
          last_failure_at: snapshot.lastDatabaseFailureAt,
        },
        queue: snapshot.queue && {
          queued: snapshot.queue.queued,
          retrying: snapshot.queue.retrying,
          running: snapshot.queue.running,
          dead_lettered: snapshot.queue.deadLettered,
          oldest_queued_at: snapshot.queue.oldestQueuedAt,
        },
      }),
    );
  });
}

export async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

export async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
