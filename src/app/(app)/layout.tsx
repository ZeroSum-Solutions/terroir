import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth-context";
import { RestaurantProvider } from "@/lib/context/restaurant";
import { SettingsDropdown } from "./settings-dropdown";
import { DesktopNavLinks, MobileNavLinks } from "./nav-links";
import { Fab } from "./fab";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const auth = await getAuthContext();
  if (!auth) redirect("/login");

  const { restaurantId, restaurantName, userRole, user } = auth;

  return (
    <RestaurantProvider restaurantId={restaurantId} restaurantName={restaurantName} userRole={userRole}>
    <div className="flex min-h-screen flex-col bg-surface">
      {/* Top bar — minimal on mobile, full nav on md+ */}
      <header className="sticky top-0 z-10 flex h-14 items-center border-b border-border bg-surface/95 px-md backdrop-blur-sm md:h-16 md:px-lg">
        <Link
          href="/"
          className="font-serif text-[20px] text-accent md:text-[22px]"
          style={{ fontWeight: 500 }}
        >
          Terroir
        </Link>

        {/* Desktop nav */}
        <nav className="ml-xl hidden items-center gap-2xs md:flex" aria-label="Primary">
          <DesktopNavLinks role={userRole} />
        </nav>

        <div className="ml-auto flex items-center gap-sm md:gap-md">
          <span className="hidden text-[12px] tabular text-ink-muted md:inline">
            {user.email}
          </span>
          <SettingsDropdown />
        </div>
      </header>

      {/* Content — bottom padding on mobile to clear the tab bar */}
      <main className="mx-auto w-full max-w-[1440px] flex-1 px-md py-lg pb-[88px] md:px-lg md:py-xl md:pb-xl">
        {children}
      </main>

      {/* Bottom tab bar — mobile only, thumb-friendly. Now 4 tabs
          per the v5 IA redesign (.council/specs/2026-04-24-ux-ia-redesign.md).
          Was 6-7 tabs (truncating at ~55px on a 390px phone); now ~97px
          per tab. */}
      <nav
        className="fixed inset-x-0 bottom-0 z-20 flex border-t border-border bg-surface/95 backdrop-blur-sm md:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        aria-label="Primary mobile"
      >
        <MobileNavLinks role={userRole} />
      </nav>

      {/* Floating Action Button — mobile-only primary actions surface.
          Speed-dial: tap "+" to reveal Scan / Pour / 86 / Voice (stub).
          Hidden on /scan (already a primary-action surface). */}
      <Fab />
    </div>
    </RestaurantProvider>
  );
}
