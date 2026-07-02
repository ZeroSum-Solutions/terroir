import { describe, it, expect } from "vitest";
import { GET } from "@/app/api/health/route";

describe("GET /api/health", () => {
  it("returns HTTP 200 with database status indicator", async () => {
    const res = await GET();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty("status", "ok");
    expect(body).toHaveProperty("db");
    expect(["connected", "error", "unconfigured"]).toContain(body.db);
    expect(body).toHaveProperty("timestamp");

    console.log("Health check response:", JSON.stringify(body, null, 2));
  });
});
