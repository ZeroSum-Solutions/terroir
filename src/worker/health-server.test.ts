import type { AddressInfo } from "node:net";
import { get } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { close, createWorkerHealthServer } from "./health-server.ts";

const servers: ReturnType<typeof createWorkerHealthServer>[] = [];

function request(port: number) {
  return new Promise<{ status: number; body: Record<string, unknown> }>(
    (resolve, reject) => {
      get(`http://127.0.0.1:${port}/health`, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(body),
          }),
        );
      }).on("error", reject);
    },
  );
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(close));
});

describe("worker health server", () => {
  it("is fail-closed until the database poll succeeds and exposes no job payload", async () => {
    let status: "starting" | "ready" = "starting";
    const server = createWorkerHealthServer({
      snapshot: () => ({
        status,
        activeJobs: 0,
        acceptingJobs: false,
        capacity: 4,
        registeredHandlers: 0,
        lastDatabaseSuccessAt: status === "ready" ? new Date().toISOString() : null,
        lastDatabaseFailureAt: null,
        queue: null,
      }),
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const starting = await request(port);
    expect(starting.status).toBe(503);
    expect(starting.body).toMatchObject({
      service: "terroir-worker",
      readiness: "starting",
    });

    status = "ready";
    const ready = await request(port);
    expect(ready.status).toBe(200);
    expect(JSON.stringify(ready.body)).not.toContain("metadata");
  });
});
