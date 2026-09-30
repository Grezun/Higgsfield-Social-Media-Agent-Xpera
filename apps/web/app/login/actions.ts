"use server";
import { signInRedirectUrl } from "@/lib/site-url";
import { createClient } from "@/lib/supabase/server";

export type LoginState = { error?: string; sent?: boolean };

export async function sendMagicLink(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) return { error: "Enter a valid email address." };
  const siteUrl = process.env.SITE_URL;
  const redirectTo = signInRedirectUrl(siteUrl);
  if (!redirectTo) return { error: "Sign-in is not configured (SITE_URL missing)." };
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo: redirectTo },
  });
  if (error) return { error: "We couldn't send a sign-in link. This app is invite-only: ask an admin to invite your email." };
  return { sent: true };
}
