import { parseStoryboard, SceneFailuresError, UnsupportedFormatError } from "@reel/core";
import { makeTestImage, makeTestTone, makeTestVideo, probe } from "@reel/media";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileAssetStore } from "./asset-store";
import { HiggsfieldImageGen, HiggsfieldVideoGen } from "./providers/higgsfield";
import { generateAssets, hashes, renderAndExport, type PipelineDeps } from "./pipeline";
import { createFakeProviders } from "./providers/fake";
import type { PlanRequest } from "./providers/types";

const REQ: PlanRequest = {
  brief: "3 tips",
  language: "he",
  targetDurationSec: 15,
  pacing: "punchy",
  captionPreset: "bold_pop",
  palette: ["#FFE14D", "#111111"],
  voice: { voiceId: "fake", modelId: "eleven_v4" },
};

async function setup(failPromptsContaining?: string) {
  const dir = await mkdtemp(join(tmpdir(), "pipeline-"));
  const providers = createFakeProviders({ workDir: dir, failPromptsContaining });
  const deps: PipelineDeps = { providers, store: new FileAssetStore(join(dir, "cache")), tmpDir: dir, log: () => {} };
  return { dir, providers, deps };
}

describe("pipeline (fake providers, real ffmpeg + Remotion)", () => {
  it("generates, renders and exports a Hebrew faceless reel, then reuses every cached asset", async () => {
    const { dir, providers, deps } = await setup();
    const sb = await providers.planner.plan(REQ);
    const gen = await generateAssets(sb, deps);
    expect(Object.keys(gen.visuals).sort()).toEqual(["s1", "s2"]);
    expect(gen.spans).toHaveLength(3);

    const out = await renderAndExport(sb, gen, deps, join(dir, "out"));
    const info = await probe(out.reel);
    expect(info.video).toMatchObject({ width: 1080, height: 1920, codec: "h264", pixFmt: "yuv420p" });
    expect(info.video!.fps).toBeCloseTo(30, 3);
    expect(info.audio).toMatchObject({ codec: "aac", sampleRate: 48000 });
    expect(Math.abs(info.durationSec - out.timeline.durationInFrames / 30)).toBeLessThan(0.1);
    expect(out.timeline.direction).toBe("rtl");
    expect((await probe(out.preview)).video).toMatchObject({ width: 540, height: 960 });

    const before = { ...providers.calls };
    await generateAssets(sb, deps);
    expect(providers.calls).toEqual(before);
  }, 600_000);

  it("caches successful scenes and reports the failed one", async () => {
    const { providers, deps } = await setup("FAIL");
    const sb = await providers.planner.plan(REQ);
    sb.scenes[1].visual.prompt = "FAIL this prompt";
    const err = await generateAssets(sb, deps).catch((e) => e);
    expect(err).toBeInstanceOf(SceneFailuresError);
    expect(err.failures).toEqual([{ sceneId: "s2", reason: expect.stringMatching(/content moderation/) }]);
    expect(await deps.store.get(hashes.image(providers.image.model, sb.scenes[0].visual.prompt!))).not.toBeNull();
  }, 300_000);

  it("fake providers use model ids distinct from the real defaults", async () => {
    const { providers } = await setup();
    const gateway = {} as ConstructorParameters<typeof HiggsfieldImageGen>[0];
    expect(providers.image.model).not.toBe(new HiggsfieldImageGen(gateway).model);
    expect(providers.video.model).not.toBe(new HiggsfieldVideoGen(gateway).model);
    expect(providers.video.resolution).toBe("fake");
  });

  it("video cache key depends on the resolution", () => {
    expect(hashes.video("m", "720p", "p", "img", 5)).not.toBe(hashes.video("m", "1080p", "p", "img", 5));
  });

  it("reuses a longer cached raw clip instead of re-billing the same b-roll", async () => {
    const { dir, providers, deps } = await setup();
    const sb = await providers.planner.plan(REQ);
    const prompt = sb.scenes[1].visual.prompt!;
    const png = join(dir, "seed.png");
    await makeTestImage(png, { color: "0x2E86AB" });
    const image = await deps.store.putFile(hashes.image(providers.image.model, prompt), png, "png", { kind: "image", provider: "test" });
    const mp4 = join(dir, "seed.mp4");
    await makeTestVideo(mp4, { durationSec: 12, width: 720, height: 1280, fps: 24 });
    await deps.store.putFile(hashes.video(providers.video.model, providers.video.resolution, prompt, image.hash, 12), mp4, "mp4", { kind: "video", provider: "test" });
    await generateAssets(sb, deps);
    expect(providers.calls.video).toBe(0);
  }, 300_000);

  it("fails clearly when a cached voice asset has no word timings", async () => {
    const { dir, providers, deps } = await setup();
    const sb = await providers.planner.plan(REQ);
    const wav = join(dir, "seed.wav");
    await makeTestTone(wav, { durationSec: 1, volumeDb: -20 });
    const voice = sb.voice!;
    const hash = hashes.voice({
      text: sb.scenes.map((s) => s.script).join(" "),
      voiceId: voice.voiceId,
      modelId: voice.modelId,
      language: sb.language,
      stability: voice.stability,
      style: voice.style,
    });
    await deps.store.putFile(hash, wav, "wav", { kind: "audio", provider: "test" });
    await expect(generateAssets(sb, deps)).rejects.toThrow(/has no word timings/);
  });

  it("refuses formats other than faceless before spending anything", async () => {
    const { providers, deps } = await setup();
    const sb = await providers.planner.plan(REQ);
    const avatar = parseStoryboard({ ...sb, format: "avatar" });
    await expect(generateAssets(avatar, deps)).rejects.toBeInstanceOf(UnsupportedFormatError);
    expect(providers.calls.voice).toBe(0);
  });
});
