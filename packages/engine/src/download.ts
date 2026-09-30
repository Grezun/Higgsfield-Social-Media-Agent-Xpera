import { copyFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  wav: "audio/wav",
  mp3: "audio/mpeg",
};

export function contentTypeFor(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

export function extFromUrl(url: string, fallback: string): string {
  const match = new URL(url).pathname.match(/\.([a-z0-9]{2,4})$/i);
  return match ? match[1].toLowerCase() : fallback;
}

export const FETCH_TIMEOUT_MS = 120_000;

/** Downloads (or copies file://) to destPath. Error messages drop the query string, which may hold signed tokens. */
export async function downloadTo(url: string, destPath: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (url.startsWith("file://")) {
    await copyFile(fileURLToPath(url), destPath);
    return;
  }
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    const { origin, pathname } = new URL(url);
    throw new Error(`Download failed with HTTP ${res.status} for ${origin}${pathname}`);
  }
  await writeFile(destPath, Buffer.from(await res.arrayBuffer()));
}
