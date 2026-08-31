import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-context", () => ({
  getAuthContext: (...args: unknown[]) => mocks.getAuthContext(...args),
}));
vi.mock("next/navigation", () => ({
  redirect: (...args: unknown[]) => mocks.redirect(...args),
}));
vi.mock("@/lib/context/restaurant", () => ({
  RestaurantProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-restaurant-provider="true">{children}</div>
  ),
}));
vi.mock("./toast-wrapper", () => ({
  ToastWrapper: ({ children }: { children: React.ReactNode }) => (
    <div data-toast-wrapper="true">{children}</div>
  ),
}));
vi.mock("./settings-dropdown", () => ({
  SettingsDropdown: () => <button data-settings="true">Settings</button>,
}));
vi.mock("./global-search", () => ({
  GlobalSearch: ({ className }: { className?: string }) => (
    <input data-global-search="true" type="search" className={className} />
  ),
}));
vi.mock("./nav-links", () => ({
  DesktopNavLinks: () => <span data-desktop-nav="true">Desktop nav</span>,
  MobileNavLinks: () => <span data-mobile-nav="true">Mobile nav</span>,
}));
vi.mock("./fab", () => ({
  Fab: () => <button data-fab="true">Actions</button>,
}));
vi.mock("./onboarding-modal", () => ({
  OnboardingModal: () => <div data-onboarding="true">Onboarding</div>,
}));

const { default: AppLayout } = await import("./layout");

describe("AppLayout shell context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("mounts the current restaurant and role without sacrificing shell edges", async () => {
    const root = await renderLayout("Bar Norman");
    const context = root.querySelector('[data-shell-context="true"]')!;
    const home = root.querySelector<HTMLAnchorElement>('a[href="/"]')!;
    const settings = root.querySelector('[data-settings="true"]')!;

    expect(context.textContent).toContain("Bar Norman");
    expect(context.textContent).toContain("Manager");
    expect(home.className).toContain("shrink-0");
    expect(home.className).toContain("min-h-11");
    expect(settings.parentElement?.className).toContain("ml-auto");
    expect(settings.parentElement?.className).toContain("shrink-0");
    expect(root.querySelector('[data-desktop-nav="true"]')).not.toBeNull();
    expect(root.querySelector('[data-mobile-nav="true"]')).not.toBeNull();
    expect(root.querySelector("header")?.parentElement?.className).toContain(
      "overflow-x-hidden",
    );
    // The bottom gutter clears the tab bar, its safe area and the FAB, and
    // comes from the chrome tokens rather than a hand-written 152px.
    expect(root.querySelector("main")?.className).toContain(
      "pb-[calc(var(--chrome-tabbar-total)+var(--chrome-fab)+var(--spacing-2xl))]",
    );
  });

  it("keeps onboarding and visible fallback context for a null restaurant", async () => {
    const root = await renderLayout(null);

    expect(
      root.querySelector('[data-shell-context="true"]')?.textContent,
    ).toContain("Unnamed restaurant");
    expect(root.querySelector('[data-onboarding="true"]')).not.toBeNull();
  });
});

async function renderLayout(restaurantName: string | null) {
  mocks.getAuthContext.mockResolvedValue({
    restaurantId: "restaurant-1",
    restaurantName,
    userRole: "manager",
    user: { email: "manager@example.com" },
  });

  const element = await AppLayout({ children: <p>Dashboard</p> });
  document.body.innerHTML = renderToStaticMarkup(element);
  return document.body;
}
