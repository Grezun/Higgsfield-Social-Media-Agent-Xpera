/** Only same-site absolute paths; anything else (protocol-relative, backslash tricks, full URLs) becomes "/". */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || /[\u0000-\u001F\u007F\s\\]/.test(raw)) return "/";
  let url: URL;
  try { url = new URL(raw, "http://local.invalid"); } catch { return "/"; }
  if (url.origin !== "http://local.invalid") return "/";
  const path = `${url.pathname}${url.search}${url.hash}`;
  return path.startsWith("//") ? "/" : path;
}
