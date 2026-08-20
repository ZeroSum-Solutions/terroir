import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SetPasswordSubmit } from "@/app/login/magic-link-submit";


export const metadata: Metadata = { title: "Set new password" };

async function setNewPassword(formData: FormData) {
  "use server";

  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (!password) {
    redirect("/auth/reset-password?error=" + encodeURIComponent("Enter a new password."));
  }
  if (password.length < 6) {
    redirect("/auth/reset-password?error=" + encodeURIComponent("Password must be at least 6 characters."));
  }
  if (password !== confirm) {
    redirect("/auth/reset-password?error=" + encodeURIComponent("Passwords don't match."));
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password });

  if (error) {
    redirect("/auth/reset-password?error=" + encodeURIComponent(error.message));
  }

  // Sign out after setting password so the user can log in with their new password
  await supabase.auth.signOut();
  redirect("/login?reset_done=1");
}

type SearchParams = Promise<{ error?: string }>;

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { error } = await searchParams;

  // Verify the user has a session (post-recovery code exchange)
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();

  if (!data.user) {
    const hdrs = await headers();
    const host = hdrs.get("host") ?? "localhost:3000";
    const proto = hdrs.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
    redirect(`${proto}://${host}/login?error=${encodeURIComponent("Reset link expired. Request a new one.")}`);
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-lg py-xl">
      <div className="w-full max-w-[420px] rounded-card border border-hairline bg-canvas p-xl">
        <div className="mb-xl text-center">
          <div className="mb-sm font-sans text-[13px] font-medium uppercase tracking-[0.22em] text-ink">
            TERR<span className="text-primary">OIR</span>
          </div>
          <h1 className="font-serif text-heading-sm leading-tight text-ink">
            Set new <em className="text-primary font-normal italic">password</em>
          </h1>
          <p className="mt-xs text-[14px] font-light text-grey">
            Choose a password for <span className="font-medium">{data.user.email}</span>
          </p>
        </div>

        <form action={setNewPassword} className="flex flex-col gap-md">
          <label htmlFor="new-password" className="flex flex-col gap-xs">
            <span className="text-caption font-medium uppercase text-grey">
              New password
            </span>
            <input
              id="new-password"
              type="password"
              name="password"
              autoComplete="new-password"
              required
              minLength={6}
              aria-describedby={error ? "reset-password-error" : undefined}
              placeholder="At least 6 characters"
              className="h-[42px] rounded-pill border border-hairline bg-white px-md text-[14px] text-ink outline-none focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-blush-wash"
            />
          </label>
          <label htmlFor="confirm-password" className="flex flex-col gap-xs">
            <span className="text-caption font-medium uppercase text-grey">
              Confirm password
            </span>
            <input
              id="confirm-password"
              type="password"
              name="confirm"
              autoComplete="new-password"
              required
              minLength={6}
              aria-describedby={error ? "reset-password-error" : undefined}
              placeholder="Same password again"
              className="h-[42px] rounded-pill border border-hairline bg-white px-md text-[14px] text-ink outline-none focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-blush-wash"
            />
          </label>
          {error && (
            <div id="reset-password-error" role="alert" className="text-[13px] text-primary">{error}</div>
          )}
<SetPasswordSubmit />
        </form>
      </div>
    </main>
  );
}
