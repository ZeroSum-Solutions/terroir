import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useParams: () => ({ token: "invite-token" }),
  useRouter: () => ({ push }),
}));

const { default: AcceptInvitePage } = await import("./page");

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousActEnvironment = reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT;

beforeAll(() => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

describe("AcceptInvitePage", () => {
  let root: Root | undefined;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = undefined;
    vi.unstubAllGlobals();
    push.mockReset();
    document.body.innerHTML = "";
  });

  it("renders a structured API error as text with a touch-sized recovery action", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: vi.fn().mockResolvedValue(
          {
            error: { code: "invalid_invite", message: "Invalid or expired invitation." },
          },
        ),
      }),
    );
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<AcceptInvitePage />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Invalid or expired invitation.");
    const loginButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Go to login",
    );
    expect(loginButton?.className).toContain("h-11");
  });
});
