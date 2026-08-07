import { describe, expect, it } from "vitest";
import { createWorkerTelemetry } from "./telemetry.ts";

describe("worker telemetry", () => {
  it("emits correlations and redacts fields outside the safe allowlist", () => {
    const lines: string[] = [];
    const telemetry = createWorkerTelemetry({
      workerId: "worker-1",
      environment: "staging",
      release: "abcdef123",
      write: (line) => lines.push(line),
    });
    telemetry.emit("job_failed", {
      error_code: "provider_timeout",
      job_id: "11111111-1111-1111-1111-111111111111",
      metadata: "customer invoice body",
      outcome: "retrying",
    });

    const event = JSON.parse(lines[0]);
    expect(event).toMatchObject({
      event: "job_failed",
      environment: "staging",
      release: "abcdef123",
      service: "terroir-worker",
      worker_id: "worker-1",
      metadata: "[REDACTED]",
    });
    expect(lines[0]).not.toContain("customer invoice body");
  });
});
