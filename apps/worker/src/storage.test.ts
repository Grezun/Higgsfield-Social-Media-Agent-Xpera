import { createFakeProviders, FileAssetStore, generateAssets, type PlanRequest } from "@reel/engine";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MirroredAssetStore } from "./storage";
import { InMemoryAssetIndex, InMemoryBlobStore } from "./testing/fakes";

const HASH = "a".repeat(64);
const meta = { kind: "audio" as const, provider: "elevenlabs", model: "eleven_v4", requestId: "r1", estUsd: 0.01, extra: { words: [{ text: "hi", startMs: 0, endMs: 100 }] } };

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "mirror-"));
  const src = join(dir, "voice.wav");
  await writeFile(src, "wav-bytes");
  return { dir, src, blobs: new InMemoryBlobStore(), index: new InMemoryAssetIndex() };
}

describe("MirroredAssetStore", () => {
  it("putFile stores locally, uploads to the assets bucket, then indexes", async () => {
    const { dir, src, blobs, index } = await setup();
    const store = new MirroredAssetStore(new FileAssetStore(join(dir, "a")), blobs, index);
    const stored = await store.putFile(HASH, src, "wav", meta);
    expect(stored.fileName).toBe(`${HASH}.wav`);
    expect(blobs.objects.get(`assets/${HASH}.wav`)?.toString()).toBe("wav-bytes");
    expect(index.records.get(HASH)).toMatchObject({
      inputHash: HASH, kind: "audio", fileName: `${HASH}.wav`, storagePath: `${HASH}.wav`, provider: "elevenlabs", model: "eleven_v4", requestId: "r1",
      meta: { estUsd: 0.01, extra: meta.extra },
    });
  });

  it("a local hit never touches the index", async () => {
    const { dir, src, blobs, index } = await setup();
    const store = new MirroredAssetStore(new FileAssetStore(join(dir, "a")), blobs, index);
    await store.putFile(HASH, src, "wav", meta);
    index.finds = 0;
    expect(await store.get(HASH)).not.toBeNull();
    expect(index.finds).toBe(0);
  });

  it("restores an asset made on another machine from Storage, metadata included", async () => {
    const { dir, src, blobs, index } = await setup();
    await new MirroredAssetStore(new FileAssetStore(join(dir, "machineA")), blobs, index).putFile(HASH, src, "wav", meta);
    const b = new MirroredAssetStore(new FileAssetStore(join(dir, "machineB")), blobs, index);
    const restored = await b.get(HASH);
    expect(restored).toMatchObject({ hash: HASH, fileName: `${HASH}.wav`, meta: { kind: "audio", provider: "elevenlabs", extra: meta.extra } });
    expect((await readFile(restored!.path)).toString()).toBe("wav-bytes");
  });

  it("returns null when the index has no record", async () => {
    const { dir, blobs, index } = await setup();
    expect(await new MirroredAssetStore(new FileAssetStore(join(dir, "a")), blobs, index).get(HASH)).toBeNull();
  });

  it("returns null (and logs) when the indexed object is missing from Storage", async () => {
    const { dir, src, blobs, index } = await setup();
    await new MirroredAssetStore(new FileAssetStore(join(dir, "a")), blobs, index).putFile(HASH, src, "wav", meta);
    blobs.objects.clear();
    const logs: string[] = [];
    const b = new MirroredAssetStore(new FileAssetStore(join(dir, "b")), blobs, index, (m) => logs.push(m));
    expect(await b.get(HASH)).toBeNull();
    expect(logs.join("\n")).toMatch(/restore failed/);
  });

  it("a second machine regenerates nothing for the same storyboard", async () => {
    const { dir, blobs, index } = await setup();
    const providers = createFakeProviders({ workDir: dir });
    const req: PlanRequest = { brief: "3 tips", language: "he", targetDurationSec: 15, pacing: "punchy", captionPreset: "bold_pop", palette: ["#FFE14D", "#111111"], voice: { voiceId: "fake-voice", modelId: "eleven_v4" } };
    const sb = await providers.planner.plan(req);
    const log = () => {};
    await generateAssets(sb, { providers, store: new MirroredAssetStore(new FileAssetStore(join(dir, "A")), blobs, index), tmpDir: join(dir, "tA"), log });
    const before = { ...providers.calls };
    await generateAssets(sb, { providers, store: new MirroredAssetStore(new FileAssetStore(join(dir, "B")), blobs, index), tmpDir: join(dir, "tB"), log });
    expect(providers.calls).toEqual(before);
  }, 300_000);
});
