import type { Timeline } from "./schema/timeline";

/** Stored timelines reference cached assets as `asset:<fileName>`; consumers resolve them to URLs they can load. */
export const ASSET_SRC_PREFIX = "asset:";
export const assetSrc = (fileName: string) => `${ASSET_SRC_PREFIX}${fileName}`;

const refOf = (src?: string) => (src?.startsWith(ASSET_SRC_PREFIX) ? src.slice(ASSET_SRC_PREFIX.length) : undefined);

export function timelineAssetFiles(t: Timeline): string[] {
  const refs = [t.audio.voiceUrl, t.audio.musicUrl, ...t.clips.map((c) => c.src)].map(refOf).filter((r): r is string => !!r);
  return [...new Set(refs)];
}

export function mapTimelineSources(t: Timeline, resolve: (fileName: string) => string): Timeline {
  const map = (src?: string) => {
    const ref = refOf(src);
    return ref ? resolve(ref) : src;
  };
  return {
    ...t,
    audio: { ...t.audio, voiceUrl: map(t.audio.voiceUrl), musicUrl: map(t.audio.musicUrl) },
    clips: t.clips.map((c) => ({ ...c, src: map(c.src) })),
  };
}
