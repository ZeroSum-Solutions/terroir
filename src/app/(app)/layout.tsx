import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { RestaurantProvider } from "@/lib/context/restaurant";
import { OnboardingModal } from "./onboarding-modal";
import { SettingsDropdown } from "./settings-dropdown";
import { DesktopNavLinks, MobileNavLinks } from "./nav-links";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Fetch the user's restaurant membership
  const { data: membership } = user
    ? await supabase
        .from("memberships")
        .select("restaurant_id, role, restaurants(name)")
        .eq("user_id", user.id)
        .limit(1)
        .single()
    : { data: null };

  const restaurantId = membership?.restaurant_id ?? "";
  const restaurantName =
    (membership?.restaurants as { name: string } | null)?.name ?? "My Restaurant";
  const userRole = (membership?.role ?? "staff") as "owner" | "manager" | "staff";
  const needsOnboarding = restaurantName === "My Restaurant";

  return (
    <RestaurantProvider restaurantId={restaurantId} restaurantName={restaurantName} userRole={userRole}>
    {needsOnboarding && restaurantId && (
      <OnboardingModal restaurantId={restaurantId} />
    )}
    <div className="flex min-h-screen flex-col bg-surface">
      {/* Top bar — minimal on mobile, full nav on md+ */}
      <header className="sticky top-0 z-10 flex h-14 items-center border-b border-border bg-surface/95 px-md backdrop-blur-sm md:h-16 md:px-lg">
        <Link
          href="/scanner"
          className="font-serif text-[20px] text-accent md:text-[22px]"
          style={{ fontWeight: 500 }}
        >
          Terroir
        </Link>

        {/* Desktop nav */}
        <nav className="ml-xl hidden items-center gap-2xs md:flex" aria-label="Primary">
          <DesktopNavLinks />
        </nav>

        <div className="ml-auto flex items-center gap-sm md:gap-md">
          <span className="hidden text-[12px] tabular text-ink-muted md:inline">
            {user?.email}
          </span>
          <SettingsDropdown />
        </div>
      </header>

      {/* Content — bottom padding on mobile to clear the tab bar */}
      <main className="mx-auto w-full max-w-[1440px] flex-1 px-md py-lg pb-[88px] md:px-lg md:py-xl md:pb-xl">
        {children}
      </main>

      {/* Bottom tab bar — mobile only, thumb-friendly */}
      <nav
        className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-4 border-t border-border bg-surface/95 backdrop-blur-sm md:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        aria-label="Primary mobile"
      >
        <MobileNavLinks />
      </nav>
    </div>
    </RestaurantProvider>
  );
}
