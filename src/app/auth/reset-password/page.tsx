import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SetPasswordSubmit } from "@/app/login/magic-link-submit";
import { authErrorMessage, loginUrl } from "@/lib/auth/redirects";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Set new password" };

async function setNewPassword(formData: FormData) {
  "use server";

  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (password.length < 6 || password.length > 256) {
    redirect("/auth/reset-password?error=invalid_password");
  }
  if (password !== confirm) {
    redirect("/auth/reset-password?error=password_mismatch");
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) redirect("/auth/reset-password?error=unavailable");

  await supabase.auth.signOut({ scope: "global" });
  redirect("/login?reset_done=1");
}

type SearchParams = Promise<{ error?: string }>;

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { error: errorCode } = await searchParams;
  const error = authErrorMessage(errorCode);
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();

  if (!data.user) redirect(loginUrl({ error: "link" }));

  const inputClassName =
    "min-h-11 rounded-pill border border-hairline bg-white px-md text-[16px] text-ink outline-none transition-colors focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-primary/25";

  return (
    <main className="dawn-gradient flex min-h-screen items-center justify-center px-md py-lg sm:px-lg sm:py-xl">
      <div className="glass w-full max-w-[420px] rounded-card p-lg sm:p-xl">
        <div className="mb-xl text-center">
          <div className="mb-sm font-sans text-[13px] font-medium uppercase tracking-[0.22em] text-ink">
            TERR<span className="text-primary">OIR</span>
          </div>
          <h1 className="font-serif text-heading-sm leading-tight text-ink">
            Set new password
          </h1>
          <p className="mt-xs text-[14px] font-light text-grey">
            Choose a password for{" "}
            <span className="font-medium">{data.user.email}</span>
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
              maxLength={256}
              aria-describedby={error ? "reset-password-error" : undefined}
              placeholder="At least 6 characters"
              className={inputClassName}
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
              maxLength={256}
              aria-describedby={error ? "reset-password-error" : undefined}
              placeholder="Enter the same password"
              className={inputClassName}
            />
          </label>
          {error && (
            <div
              id="reset-password-error"
              role="alert"
              aria-live="assertive"
              className="rounded-md border border-primary/30 bg-blush-wash p-md text-[13px] text-primary"
            >
              {error}
            </div>
          )}
          <SetPasswordSubmit />
        </form>
      </div>
    </main>
  );
}
