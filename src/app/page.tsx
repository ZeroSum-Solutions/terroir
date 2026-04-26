import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth-context";

/**
 * Public root. Redirects to either /login (unauthed) or the role-
 * appropriate landing page (authed).
 *
 * Default landing per role (per .council/specs/2026-04-24-ux-ia-redesign.md
 * §3 — addresses the two-buyer reality from Wave 3 research):
 *   owner   → /insights  (the buyer wants the dashboard / Monday briefing)
 *   manager → /cellar    (operational lead)
 *   staff   → /cellar    (floor operator)
 *
 * Logo links throughout the app point at "/" so this redirector is
 * what runs on every "go home" tap. Keeps role-specific muscle
 * memory consistent.
 */
export default async function Home() {
  const auth = await getAuthContext();
  if (!auth) redirect("/login");

  switch (auth.userRole) {
    case "owner":
      redirect("/insights");
    case "manager":
    case "staff":
      redirect("/cellar");
    default:
      redirect("/cellar");
  }
}
