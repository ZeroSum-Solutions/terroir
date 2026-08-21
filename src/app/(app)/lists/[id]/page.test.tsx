import { NextResponse } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  redirect: vi.fn(),
  notFound: vi.fn(),
}));

vi.mock("@/lib/api/auth", () => ({
  requireMembership: mocks.requireMembership,
}));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
  notFound: mocks.notFound,
}));

vi.mock("./wine-list-editor", () => ({
  WineListEditor: () => null,
}));

const { default: WineListEditorPage } = await import("./page");

beforeEach(() => {
  vi.clearAllMocks();
});

it("returns unauthenticated users to the canonical list editor URL", async () => {
  mocks.requireMembership.mockResolvedValue(
    NextResponse.json({}, { status: 401 }),
  );
  mocks.redirect.mockImplementation((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  });

  await expect(
    WineListEditorPage({ params: Promise.resolve({ id: "list-1" }) }),
  ).rejects.toThrow("NEXT_REDIRECT:/login?next=/lists/list-1");
  expect(mocks.redirect).toHaveBeenCalledWith("/login?next=/lists/list-1");
});
