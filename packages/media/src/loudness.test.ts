import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isSilent, measureLoudness, normalizeLoudness, VOICE_LOUDNESS } from "./loudness";
import { probe } from "./probe";
import { makeTestTone } from "./testing";

describe("loudness", () => {
  it("normalizes a quiet tone to the voice target within 1 LU", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loud-"));
    const src = join(dir, "quiet.wav");
    await makeTestTone(src, { durationSec: 5, volumeDb: -30 });
    const out = join(dir, "norm.wav");
    await normalizeLoudness(src, out, VOICE_LOUDNESS);
    const m = await measureLoudness(out, VOICE_LOUDNESS);
    expect(Math.abs(m.inputI - VOICE_LOUDNESS.i)).toBeLessThanOrEqual(1);
    expect((await probe(out)).audio).toMatchObject({ sampleRate: 48000, codec: "pcm_s16le" });
  });

  it("handles digital silence without producing NaN filters", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loud-"));
    const src = join(dir, "silent.wav");
    await makeTestTone(src, { durationSec: 2, volumeDb: -200 });
    expect(isSilent(await measureLoudness(src))).toBe(true);
    await expect(normalizeLoudness(src, join(dir, "silent-out.wav"))).resolves.toBeUndefined();
  });
});
