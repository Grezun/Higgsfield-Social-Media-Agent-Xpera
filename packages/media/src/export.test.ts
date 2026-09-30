import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { exportDeliverable, thumbnail } from "./export";
import { measureLoudness, SOCIAL_LOUDNESS } from "./loudness";
import { probe } from "./probe";
import { makeTestVideo } from "./testing";

let dir: string;
let master: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "export-"));
  master = join(dir, "master.mp4");
  await makeTestVideo(master, { durationSec: 4, withAudio: true });
});

describe("exportDeliverable", () => {
  it("social_1080p meets the delivery spec", async () => {
    const out = join(dir, "reel.mp4");
    await exportDeliverable(master, out, "social_1080p");
    const info = await probe(out);
    expect(info.video).toMatchObject({ width: 1080, height: 1920, codec: "h264", pixFmt: "yuv420p" });
    expect(info.video!.fps).toBeCloseTo(30, 3);
    expect(info.audio).toMatchObject({ codec: "aac", sampleRate: 48000 });
    const m = await measureLoudness(out, SOCIAL_LOUDNESS);
    expect(Math.abs(m.inputI - SOCIAL_LOUDNESS.i)).toBeLessThanOrEqual(1.5);
  });

  it("preview_540p is 540×960", async () => {
    const out = join(dir, "preview.mp4");
    await exportDeliverable(master, out, "preview_540p");
    expect((await probe(out)).video).toMatchObject({ width: 540, height: 960 });
  });

  it("exports a master without audio", async () => {
    const silentMaster = join(dir, "no-audio.mp4");
    await makeTestVideo(silentMaster, { durationSec: 1 });
    const out = join(dir, "no-audio-out.mp4");
    await exportDeliverable(silentMaster, out);
    expect((await probe(out)).audio).toBeUndefined();
  });
});

describe("thumbnail", () => {
  it("writes a 540-wide JPEG", async () => {
    const out = join(dir, "thumb.jpg");
    await thumbnail(master, out, 1);
    expect((await probe(out)).video).toMatchObject({ width: 540, height: 960 });
  });
});
