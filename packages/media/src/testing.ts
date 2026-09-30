import { runFfmpeg } from "./run";

/** Synthetic fixtures generated with lavfi, so no binary media is committed. */
export async function makeTestVideo(
  out: string,
  { durationSec = 2, width = 1080, height = 1920, fps = 30, withAudio = false } = {},
): Promise<void> {
  await runFfmpeg([
    "-f", "lavfi", "-i", `testsrc2=size=${width}x${height}:rate=${fps}:duration=${durationSec}`,
    ...(withAudio ? ["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${durationSec}`] : []),
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    ...(withAudio ? ["-c:a", "aac", "-shortest"] : []),
    out,
  ]);
}

export async function makeTestTone(
  out: string,
  { durationSec = 2, volumeDb = -20, trailingSilenceSec = 0 } = {},
): Promise<void> {
  await runFfmpeg([
    "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${durationSec}`,
    "-af", `volume=${volumeDb}dB,apad=pad_dur=${trailingSilenceSec}`,
    "-c:a", "pcm_s16le", out,
  ]);
}

export async function makeTestImage(out: string, { width = 1080, height = 1920, color = "blue" } = {}): Promise<void> {
  await runFfmpeg(["-f", "lavfi", "-i", `color=c=${color}:size=${width}x${height}`, "-frames:v", "1", out]);
}
