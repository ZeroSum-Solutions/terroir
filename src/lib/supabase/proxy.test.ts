import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

function requestFor(path: string) {
  return new NextRequest(`http://localhost:3000${path}`);
}

describe("updateSession missing Supabase public config", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
    vi.stubEnv("NODE_ENV", "test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows public routes in local/test environments", async () => {
    const res = await updateSession(requestFor("/login"));

    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("redirects protected routes to login in local/test environments", async () => {
    const res = await updateSession(requestFor("/cellar"));
    const location = res.headers.get("location");

    expect(res.status).toBe(307);
    expect(location).toBeTruthy();

    const url = new URL(location ?? "");
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("next")).toBe("/cellar");
  });

  it("fails closed in production when required config is missing", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const res = await updateSession(requestFor("/login"));

    expect(res.status).toBe(503);
  });
});
