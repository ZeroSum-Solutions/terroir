"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { safeNext } from "@/lib/api/safe-redirect";
import { consumeAuthAttempt } from "@/lib/auth/attempt-rate-limit";
import { appUrl, authCallbackUrl, loginUrl } from "@/lib/auth/redirects";
import { createClient } from "@/lib/supabase/server";

const EmailSchema = z.string().trim().toLowerCase().email();
const PasswordSchema = z.string().min(6).max(256);

function getEmail(formData: FormData): string | null {
  const parsed = EmailSchema.safeParse(formData.get("email"));
  return parsed.success ? parsed.data : null;
}

function getPassword(formData: FormData): string | null {
  const parsed = PasswordSchema.safeParse(formData.get("password"));
  return parsed.success ? parsed.data : null;
}

function getNext(formData: FormData): string {
  const value = formData.get("next");
  return safeNext(typeof value === "string" ? value : null, "/");
}

async function enforceAttemptLimit(options: {
  next?: string;
  forgot?: boolean;
  password?: boolean;
  signup?: boolean;
}): Promise<void> {
  if (consumeAuthAttempt(await headers()).ok) return;
  redirect(loginUrl({ ...options, error: "rate_limited" }));
}

export async function sendMagicLink(formData: FormData) {
  const next = getNext(formData);
  const email = getEmail(formData);
  if (!email) redirect(loginUrl({ next, error: "invalid_email" }));
  await enforceAttemptLimit({ next });

  let requestFailed = false;
  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: authCallbackUrl(next),
        shouldCreateUser: true,
      },
    });
    requestFailed = error !== null;
  } catch {
    requestFailed = true;
  }
  if (requestFailed) redirect(loginUrl({ next, error: "unavailable" }));
  redirect(loginUrl({ next, magicSent: true }));
}

export async function signInWithPassword(formData: FormData) {
  const next = getNext(formData);
  const email = getEmail(formData);
  if (!email) {
    redirect(loginUrl({ next, password: true, error: "invalid_email" }));
  }
  const password = getPassword(formData);
  if (!password) {
    redirect(loginUrl({ next, password: true, error: "invalid_password" }));
  }
  await enforceAttemptLimit({ next, password: true });

  let credentialsRejected = false;
  let requestFailed = false;
  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    credentialsRejected = error !== null;
  } catch {
    requestFailed = true;
  }
  if (credentialsRejected) {
    redirect(loginUrl({ next, password: true, error: "invalid_credentials" }));
  }
  if (requestFailed) {
    redirect(loginUrl({ next, password: true, error: "unavailable" }));
  }
  redirect(appUrl(next).toString());
}

export async function signUpWithPassword(formData: FormData) {
  const next = getNext(formData);
  const email = getEmail(formData);
  if (!email) {
    redirect(loginUrl({ next, signup: true, error: "invalid_email" }));
  }
  const password = getPassword(formData);
  if (!password) {
    redirect(loginUrl({ next, signup: true, error: "invalid_password" }));
  }
  if (formData.get("confirm") !== password) {
    redirect(loginUrl({ next, signup: true, error: "password_mismatch" }));
  }
  await enforceAttemptLimit({ next, signup: true });

  let requestFailed = false;
  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: authCallbackUrl(next) },
    });
    requestFailed = error !== null;
  } catch {
    requestFailed = true;
  }
  if (requestFailed) {
    redirect(loginUrl({ next, signup: true, error: "unavailable" }));
  }
  redirect(loginUrl({ next, signupSent: true }));
}

export async function sendPasswordReset(formData: FormData) {
  const email = getEmail(formData);
  if (!email) redirect(loginUrl({ forgot: true, error: "invalid_email" }));
  await enforceAttemptLimit({ forgot: true });

  try {
    const supabase = await createClient();
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: authCallbackUrl("/auth/reset-password"),
    });
  } catch {
    // Keep provider details and account existence private.
  }
  redirect(loginUrl({ reset: true }));
}
