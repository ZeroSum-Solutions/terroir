import { describe, expect, it } from "vitest";
import nextConfig from "../../../next.config";

describe("development origin contract", () => {
  it("allows the loopback host used by local Supabase auth callbacks", () => {
    expect(nextConfig.allowedDevOrigins).toContain("127.0.0.1");
  });
});
