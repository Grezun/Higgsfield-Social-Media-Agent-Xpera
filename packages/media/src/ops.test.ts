import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { conformVideo, extractAudio, fitDuration, sliceAudio, trimTrailingSilence } from "./ops";
import { probe } from "./probe";
import { makeTestTone, makeTestVideo } from "./testing";

const FRAME = 1 / 30;
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ops-"));
});

describe("conformVideo", () => {
  it("turns a 16:9 24 fps clip into 1080×1920 30 fps yuv420p with SAR 1:1", async () => {
    const src = join(dir, "wide.mp4");
    await makeTestVideo(src, { durationSec: 2, width: 1280, height: 720, fps: 24 });
    const out = join(dir, "conformed.mp4");
    await conformVideo(src, out);
    const info = await probe(out);
    expect(info.video).toMatchObject({ width: 1080, height: 1920, pixFmt: "yuv420p", codec: "h264", sar: "1:1" });
    expect(info.video!.fps).toBeCloseTo(30, 3);
    expect(info.durationSec).toBeCloseTo(2, 1);
    expect(info.audio).toBeUndefined();
  });
});

describe("fitDuration", () => {
  const make = async (name: string, sec: number) => {
    const file = join(dir, name);
    await makeTestVideo(file, { durationSec: sec, width: 540, height: 960 });
    return file;
  };

  it("cuts a longer clip to the target", async () => {
    const out = join(dir, "cut.mp4");
    await fitDuration(await make("five.mp4", 5), out, 3);
    expect(Math.abs((await probe(out)).durationSec - 3)).toBeLessThanOrEqual(FRAME + 0.005);
  });

  it("slows a slightly short clip to the target", async () => {
    const out = join(dir, "slow.mp4");
    await fitDuration(await make("two.mp4", 2), out, 2.2);
    expect(Math.abs((await probe(out)).durationSec - 2.2)).toBeLessThanOrEqual(FRAME + 0.005);
  });

  it("slows by at most 15% then freezes the last frame (4 s clip in a 9 s scene)", async () => {
    const out = join(dir, "pad.mp4");
    await fitDuration(await make("four.mp4", 4), out, 9);
    expect(Math.abs((await probe(out)).durationSec - 9)).toBeLessThanOrEqual(FRAME + 0.005);
  });

  it("cuts the 4 s minimum clip down to a 2 s scene", async () => {
    const out = join(dir, "short-scene.mp4");
    await fitDuration(await make("four-b.mp4", 4), out, 2);
    expect(Math.abs((await probe(out)).durationSec - 2)).toBeLessThanOrEqual(FRAME + 0.005);
  });
});

describe("audio ops", () => {
  it("extracts mono 16 kHz WAV from a video with audio", async () => {
    const src = join(dir, "av.mp4");
    await makeTestVideo(src, { durationSec: 2, width: 320, height: 240, withAudio: true });
    const out = join(dir, "extracted.wav");
    await extractAudio(src, out);
    const info = await probe(out);
    expect(info.audio).toEqual({ codec: "pcm_s16le", sampleRate: 16000, channels: 1 });
    expect(info.video).toBeUndefined();
  });

  it("slices an exact window", async () => {
    const src = join(dir, "tone3.wav");
    await makeTestTone(src, { durationSec: 3 });
    const out = join(dir, "slice.wav");
    await sliceAudio(src, out, 500, 1700);
    expect((await probe(out)).durationSec).toBeCloseTo(1.2, 2);
  });

  it("trims trailing silence but keeps leading timing", async () => {
    const src = join(dir, "tone-silence.wav");
    await makeTestTone(src, { durationSec: 2, trailingSilenceSec: 3 });
    const out = join(dir, "trimmed.wav");
    await trimTrailingSilence(src, out);
    const d = (await probe(out)).durationSec;
    expect(d).toBeGreaterThan(2.05);
    expect(d).toBeLessThan(2.3);
  });
});
