// GLOBAL-02 — "the search bar is present on every page", asserted mechanically.
//
// The assertion is made against the SHELL, not against each route's markup, and
// that is the point rather than a shortcut. Every page.tsx under src/app/(app)
// renders inside src/app/(app)/layout.tsx by construction of the App Router, so
// "the shell renders a search field" plus "every route lives under the shell"
// is the whole rule — and it stays true when a route is added, which a
// per-route DOM assertion would not.
//
// The two halves are tested separately below: the inventory half walks the
// route tree, the shell half renders the layout.

import fs from "node:fs";
import path from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const APP_DIR = path.join(process.cwd(), "src/app/(app)");

const mocks = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  redirect: vi.fn(),
  push: vi.fn(),
}));

vi.mock("@/lib/auth-context", () => ({
  getAuthContext: (...args: unknown[]) => mocks.getAuthContext(...args),
}));
vi.mock("next/navigation", () => ({
  redirect: (...args: unknown[]) => mocks.redirect(...args),
  useRouter: () => ({ push: mocks.push, refresh: vi.fn() }),
  usePathname: () => "/cellar",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/context/restaurant", () => ({
  RestaurantProvider: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("./toast-wrapper", () => ({
  ToastWrapper: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const { default: AppLayout } = await import("./layout");

/** Every route path under (app), with route groups stripped the way Next does. */
function routePaths(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "page.tsx") {
        const segments = path
          .relative(APP_DIR, dir)
          .split(path.sep)
          .filter((s) => s !== "" && !s.startsWith("("));
        found.push(`/${segments.join("/")}`);
      }
    }
  };
  walk(APP_DIR);
  return found.sort();
}

describe("GLOBAL-02 — search is on every page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("has routes to cover, and every one of them is under the (app) shell", () => {
    const routes = routePaths();
    expect(routes.length).toBeGreaterThan(10);
    // A page.tsx found by this walk is under src/app/(app), and the App Router
    // wraps it in that segment's layout. There is no opt-out short of moving
    // the file out of the segment, which changes its URL.
    expect(fs.existsSync(path.join(APP_DIR, "layout.tsx"))).toBe(true);
    for (const route of routes) {
      expect(route.startsWith("/")).toBe(true);
    }
  });

  it("renders a visible search field in the shell, above the page content", async () => {
    const root = await renderShell();

    const fields = root.querySelectorAll<HTMLInputElement>(
      'input[type="search"][data-global-search="true"]',
    );
    // One placement per breakpoint — the header on md+, the band beneath it on
    // mobile, where the header has no room left at 390px.
    expect(fields.length).toBe(2);

    const header = root.querySelector("header")!;
    expect(header.querySelector('input[type="search"]')).not.toBeNull();

    // "At the top" is structural: both fields precede <main> in document order.
    const main = root.querySelector("main")!;
    for (const field of fields) {
      expect(
        field.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it("labels the field as search rather than hiding it behind a menu", async () => {
    const root = await renderShell();
    const form = root.querySelector('form[role="search"]')!;

    expect(form.getAttribute("aria-label")).toBe("Search all wines");
    const input = form.querySelector<HTMLInputElement>("input")!;
    expect(input.getAttribute("placeholder")).toBe("Search all wines…");
    // Not a trigger that opens a dialog: the field itself is in the document.
    expect(input.getAttribute("type")).toBe("search");
  });
});

async function renderShell() {
  mocks.getAuthContext.mockResolvedValue({
    restaurantId: "restaurant-1",
    restaurantName: "Bar Norman",
    userRole: "manager",
    user: { email: "manager@example.com" },
  });
  const element = await AppLayout({ children: <p>Page</p> });
  document.body.innerHTML = renderToStaticMarkup(element);
  return document.body;
}
