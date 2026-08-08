import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));

vi.mock("@/lib/auth-context", () => ({
  getAuthContext: (...args: unknown[]) => mocks.getAuthContext(...args),
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

const { default: CellarConfigLayout } = await import("./layout");

describe("cellar config role boundary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("redirects staff before rendering mutation controls", async () => {
    mocks.getAuthContext.mockResolvedValue({ userRole: "staff" });
    await expect(
      CellarConfigLayout({ children: <div>configuration</div> }),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.redirect).toHaveBeenCalledWith("/cellar");
  });

  it.each(["owner", "manager"] as const)("renders controls for %s", async (userRole) => {
    mocks.getAuthContext.mockResolvedValue({ userRole });
    const children = <div>configuration</div>;
    await expect(CellarConfigLayout({ children })).resolves.toBe(children);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
