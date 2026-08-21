import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth-context";
import { RestaurantProvider } from "@/lib/context/restaurant";
import { SettingsDropdown } from "./settings-dropdown";
import { DesktopNavLinks, MobileNavLinks } from "./nav-links";
import { Fab } from "./fab";
import { ToastWrapper } from "./toast-wrapper";
import { OnboardingModal } from "./onboarding-modal";
import { ShellContext } from "./shell-context";

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
      <ToastWrapper>
    <div className="flex min-h-screen flex-col overflow-x-hidden bg-canvas">
      {/* Top bar — minimal on mobile, full nav on md+. Glass Nav per DESIGN.md. */}
      <header className="glass sticky top-0 z-10 flex h-[54px] items-center px-md md:px-lg">
        <Link
          href="/"
          className="inline-flex min-h-11 shrink-0 items-center font-sans text-[13px] font-medium uppercase tracking-[0.22em] text-ink"
        >
          TERR<span className="text-primary">OIR</span>
        </Link>

        <ShellContext restaurantName={restaurantName} role={userRole} />

        {/* Desktop nav */}
        <nav className="ml-xl hidden items-center gap-lg md:flex" aria-label="Primary">
          <DesktopNavLinks role={userRole} />
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-sm md:gap-md">
          <span className="hidden text-[12px] font-light tabular text-grey md:inline">
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
        className="fixed inset-x-0 bottom-0 z-20 flex border-t border-hairline bg-canvas/95 backdrop-blur-sm md:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        aria-label="Primary mobile"
      >
        <MobileNavLinks role={userRole} />
      </nav>

      {/* Floating Action Button — mobile-only primary actions surface.
          Speed-dial: tap "+" to reveal Scan / Pour / 86.
          Hidden on /scan (already a primary-action surface). */}
      <Fab />

      {/* First-login onboarding — restaurant exists in auth but has no name yet. */}
      {(restaurantName == null || restaurantName.trim() === "") && (
        <OnboardingModal restaurantId={restaurantId} />
      )}
    </div>
    </ToastWrapper>
    </RestaurantProvider>
  );
}
