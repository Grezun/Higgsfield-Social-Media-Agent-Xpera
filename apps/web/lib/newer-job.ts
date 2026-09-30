/** Keep the newer of two job rows, comparing by instant (not string) since Postgres timestamps vary in precision. */
export function newerJob<T extends { created_at: string }>(prev: T | null, next: T): T {
  if (!prev) return next;
  return Date.parse(next.created_at) >= Date.parse(prev.created_at) ? next : prev;
}
