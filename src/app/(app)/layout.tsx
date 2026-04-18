import Link from "next/link";
import { BarChart3, ListOrdered, LogOut, ScanLine } from "lucide-react";
import { createClient } from "@/lib/supabase/server";

const TABS = [
  { href: "/scanner", label: "Scanner", Icon: ScanLine },
  { href: "/wine-list", label: "Wine Lists", Icon: ListOrdered },
  { href: "/dashboard", label: "Dashboard", Icon: BarChart3 },
] as const;

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
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
        <nav className="ml-xl hidden items-center gap-2xs md:flex">
          {TABS.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              className="rounded-sm px-md py-sm text-[14px] font-medium text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink"
            >
              {label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-sm md:gap-md">
          <span className="hidden text-[12px] tabular text-ink-muted md:inline">
            {user?.email}
          </span>
          <form action="/auth/signout" method="post">
            <button
              type="submit"
              aria-label="Sign out"
              className="flex h-10 w-10 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-muted hover:text-ink md:h-auto md:w-auto md:border md:border-border-strong md:bg-white md:px-md md:py-sm md:text-[13px] md:font-medium"
            >
              <LogOut className="h-5 w-5 md:hidden" strokeWidth={1.75} />
              <span className="hidden md:inline">Sign out</span>
            </button>
          </form>
        </div>
      </header>

      {/* Content — bottom padding on mobile to clear the tab bar */}
      <main className="mx-auto w-full max-w-[1440px] flex-1 px-md py-lg pb-[88px] md:px-lg md:py-xl md:pb-xl">
        {children}
      </main>

      {/* Bottom tab bar — mobile only, thumb-friendly */}
      <nav
        className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-3 border-t border-border bg-surface/95 backdrop-blur-sm md:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        aria-label="Primary"
      >
        {TABS.map(({ href, label, Icon }) => (
          <Link
            key={href}
            href={href}
            className="flex min-h-[64px] flex-col items-center justify-center gap-xs px-sm py-sm text-[11px] font-medium text-ink-muted active:bg-surface-muted"
          >
            <Icon className="h-6 w-6" strokeWidth={1.75} />
            <span>{label}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
