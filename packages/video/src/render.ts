import type { Timeline } from "@reel/core";
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");
let serveUrlPromise: Promise<string> | undefined;

/** Bundles the Remotion project once per process. */
export function getServeUrl(): Promise<string> {
  serveUrlPromise ??= bundle({ entryPoint: ENTRY });
  return serveUrlPromise;
}

async function prepare(timeline: Timeline) {
  const serveUrl = await getServeUrl();
  const inputProps = { timeline };
  const composition = await selectComposition({ serveUrl, id: "Reel", inputProps });
  return { serveUrl, inputProps, composition };
}

export async function renderReel(timeline: Timeline, outputLocation: string, onProgress?: (progress: number) => void): Promise<void> {
  const { serveUrl, inputProps, composition } = await prepare(timeline);
  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    crf: 12,
    pixelFormat: "yuv420p",
    audioCodec: "aac",
    outputLocation,
    inputProps,
    onProgress: ({ progress }) => onProgress?.(progress),
  });
}

export async function renderReelStill(timeline: Timeline, output: string, frame: number): Promise<void> {
  const { serveUrl, inputProps, composition } = await prepare(timeline);
  await renderStill({ composition, serveUrl, output, frame, inputProps });
}
