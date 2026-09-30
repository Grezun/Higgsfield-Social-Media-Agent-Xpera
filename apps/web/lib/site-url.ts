export function signInRedirectUrl(siteUrl: string | undefined): string | null {
  if (!siteUrl) return null;
  return `${siteUrl.replace(/\/$/, "")}/auth/confirm`;
}
