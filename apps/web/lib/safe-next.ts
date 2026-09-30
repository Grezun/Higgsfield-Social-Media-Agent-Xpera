/** Only same-site absolute paths; anything else (protocol-relative, backslash tricks, full URLs) becomes "/". */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}
