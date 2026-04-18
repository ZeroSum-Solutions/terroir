import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

const TABS = [
  { href: "/scanner", label: "Scanner" },
  { href: "/wine-list", label: "Wine Lists" },
  { href: "/dashboard", label: "Dashboard" },
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
    <div className="min-h-screen bg-surface">
      <header className="sticky top-0 z-10 flex h-16 items-center border-b border-border bg-surface/95 px-lg backdrop-blur-sm">
        <Link
          href="/scanner"
          className="font-serif text-[22px] text-accent"
          style={{ fontWeight: 500 }}
        >
          Terroir
        </Link>

        <nav className="ml-xl flex items-center gap-2xs">
          {TABS.map((tab) => (
            <Link
              key={tab.href}
              href={tab.href}
              className="rounded-sm px-md py-sm text-[14px] font-medium text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink"
            >
              {tab.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-md">
          <span className="text-[12px] tabular text-ink-muted">
            {user?.email}
          </span>
          <form action="/auth/signout" method="post">
            <button
              type="submit"
              className="rounded-sm border border-border-strong bg-white px-md py-sm text-[13px] font-medium text-ink-muted hover:text-ink"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1440px] px-lg py-xl">
        {children}
      </main>
    </div>
  );
}
