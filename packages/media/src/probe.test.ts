import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probe } from "./probe";
import { makeTestTone, makeTestVideo } from "./testing";

describe("probe", () => {
  it("reads video dimensions, fps, duration and absence of audio", async () => {
    const dir = await mkdtemp(join(tmpdir(), "media-"));
    const file = join(dir, "v.mp4");
    await makeTestVideo(file, { durationSec: 2, width: 640, height: 360, fps: 30 });
    const info = await probe(file);
    expect(info.video).toMatchObject({ width: 640, height: 360, codec: "h264", pixFmt: "yuv420p" });
    expect(info.video!.fps).toBeCloseTo(30, 3);
    expect(info.durationSec).toBeCloseTo(2, 1);
    expect(info.audio).toBeUndefined();
  });

  it("reads audio sample rate and channels", async () => {
    const dir = await mkdtemp(join(tmpdir(), "media-"));
    const file = join(dir, "t.wav");
    await makeTestTone(file, { durationSec: 1 });
    const info = await probe(file);
    expect(info.audio).toEqual({ codec: "pcm_s16le", sampleRate: 48000, channels: 1 });
    expect(info.video).toBeUndefined();
  });
});
