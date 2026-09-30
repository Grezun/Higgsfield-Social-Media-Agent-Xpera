import { isSilent, loudnormFilter, measureLoudness, SOCIAL_LOUDNESS } from "./loudness";
import { probe } from "./probe";
import { runFfmpeg } from "./run";

export type ExportPreset = {
  width: number;
  height: number;
  crf: number;
  preset: string;
  maxrate?: string;
  bufsize?: string;
  audioBitrate: string;
};

export const EXPORT_PRESETS = {
  /** One file that works for Instagram Reels, TikTok and YouTube Shorts. */
  social_1080p: { width: 1080, height: 1920, crf: 18, preset: "slow", maxrate: "12M", bufsize: "24M", audioBitrate: "192k" },
  preview_540p: { width: 540, height: 960, crf: 26, preset: "veryfast", audioBitrate: "96k" },
} satisfies Record<string, ExportPreset>;
export type ExportPresetName = keyof typeof EXPORT_PRESETS;

export async function exportDeliverable(master: string, output: string, presetName: ExportPresetName = "social_1080p"): Promise<void> {
  const p: ExportPreset = EXPORT_PRESETS[presetName];
  const info = await probe(master);
  const video = [
    "-vf", `scale=${p.width}:${p.height}:out_range=tv,fps=30,format=yuv420p`,
    "-c:v", "libx264", "-profile:v", "high", "-preset", p.preset, "-crf", String(p.crf),
    ...(p.maxrate && p.bufsize ? ["-maxrate", p.maxrate, "-bufsize", p.bufsize] : []),
  ];
  let audio = ["-an"];
  if (info.audio) {
    const m = await measureLoudness(master, SOCIAL_LOUDNESS);
    const af = isSilent(m) ? "aresample=48000" : `${loudnormFilter(m, SOCIAL_LOUDNESS)},aresample=48000`;
    audio = ["-af", af, "-c:a", "aac", "-b:a", p.audioBitrate, "-ar", "48000"];
  }
  await runFfmpeg(["-i", master, ...video, ...audio, "-movflags", "+faststart", output]);
}

export async function thumbnail(master: string, output: string, atSec = 1): Promise<void> {
  await runFfmpeg(["-ss", atSec.toFixed(3), "-i", master, "-frames:v", "1", "-vf", "scale=540:-2", "-q:v", "3", output]);
}
