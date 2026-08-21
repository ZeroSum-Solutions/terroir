import { beforeEach, describe, expect, it, vi } from "vitest";

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(url);
  }
}

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  headers: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

const { default: ResetPasswordPage } = await import("./page");

describe("reset password page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://staging.terroir.example");
    mocks.headers.mockResolvedValue(new Headers({ host: "evil.example" }));
    mocks.createClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    });
    mocks.redirect.mockImplementation((url: string) => {
      throw new RedirectSignal(url);
    });
  });

  it("sends an expired recovery session to one generic configured-origin error", async () => {
    await expect(
      ResetPasswordPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toMatchObject({
      url: "https://staging.terroir.example/login?error=link",
    });
  });
});
