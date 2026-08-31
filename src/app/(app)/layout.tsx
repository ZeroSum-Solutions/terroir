import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth-context";
import { RestaurantProvider } from "@/lib/context/restaurant";
import { SettingsDropdown } from "./settings-dropdown";
import { AssistantPanel } from "./assistant-panel";
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
      {/* Top bar — minimal on mobile, full nav on md+. Glass Nav per DESIGN.md.
          The top safe area is RESERVED, not ignored: viewportFit is "cover",
          so without this the brand mark and the settings control sit under a
          notched iPhone's Dynamic Island when Terroir is installed as a PWA.
          Geometry comes from the chrome tokens in globals.css, never from a
          hand-written 54px in one file and 56px in another. */}
      <header
        className="glass sticky top-0 z-[var(--z-sticky)] flex items-center px-md md:px-lg"
        style={{ height: "var(--chrome-header-total)", paddingTop: "var(--safe-top)" }}
      >
        <Link
          href="/"
          className="inline-flex min-h-11 shrink-0 items-center font-sans text-[13px] font-medium uppercase tracking-[0.22em] text-ink"
        >
          TERR<span className="text-mark">OIR</span>
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
          {/* In the header, not the FAB: the FAB is mobile-only and hidden on
              /scan, /login and /atlas, and the assistant is useful on all of
              them. The header renders on every authenticated page. */}
          <AssistantPanel />
          <SettingsDropdown />
        </div>
      </header>

      {/* Content — mobile bottom padding clears the tab bar AND the FAB,
          whose top edge sits ~136px above the viewport bottom (80px offset
          + 56px button). 88px let it cover the last ~48px of every list
          (Kimi audit 2026-08-26). */}
      {/* Content cap ~1160px (Kimi audit D4): the mobile stack stretched
          full-width to 1440px read as an unfinished desktop. */}
      <main className="mx-auto w-full max-w-[1160px] flex-1 px-md py-lg pb-[calc(var(--chrome-tabbar-total)+var(--chrome-fab)+var(--spacing-2xl))] md:px-lg md:py-xl md:pb-xl">
        {children}
      </main>

      {/* Bottom tab bar — mobile only, thumb-friendly. Now 4 tabs
          per the v5 IA redesign (.council/specs/2026-04-24-ux-ia-redesign.md).
          Was 6-7 tabs (truncating at ~55px on a 390px phone); now ~97px
          per tab. */}
      <nav
        className="fixed inset-x-0 bottom-0 z-[var(--z-chrome)] flex border-t border-rule bg-canvas/95 backdrop-blur-sm md:hidden"
        style={{ paddingBottom: "var(--safe-bottom)" }}
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
