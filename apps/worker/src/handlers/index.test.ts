import { costModels, createFakeProviders, FileAssetStore, loadConfig } from "@reel/engine";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FAKE_VOICE_ID } from "../fake-voice";
import { InMemoryBlobStore, InMemoryReelDb, makeJob } from "../testing/fakes";
import { buildHandlers } from "./index";

const FORM = { brief: "3 טיפים לצמיחה בטיקטוק", language: "he", targetDurationSec: 15, pacing: "punchy", captionPreset: "bold_pop", palette: ["#FFE14D", "#111111"] };
const ctx = { report: () => {}, log: () => {} };

async function setup(mode: "real" | "fake") {
  const dir = await mkdtemp(join(tmpdir(), "build-handlers-"));
  const providers = createFakeProviders({ workDir: dir });
  const db = new InMemoryReelDb();
  const config = loadConfig({ REEL_CACHE_DIR: join(dir, "cache") }, { providers: "fake" });
  const handlers = buildHandlers({
    mode, planner: providers.planner, providers, store: new FileAssetStore(config.cacheDir), blobs: new InMemoryBlobStore(), db,
    voices: { he: "voice-he" }, voiceModelId: "eleven_v4", spendCapUsd: 10, costModels: costModels(config),
  });
  return { providers, db, handlers };
}

describe("buildHandlers", () => {
  it("fake mode: the plan handler writes the fake voice even when the form names another", async () => {
    const s = await setup("fake");
    await s.handlers.plan(makeJob({ type: "plan", project_id: "p1", payload: { ...FORM, voiceId: "real-voice" } }), ctx);
    expect((s.db.storyboards[0].json as { voice: { voiceId: string } }).voice.voiceId).toBe(FAKE_VOICE_ID);
  });

  it("real mode: the generate handler refuses a fake-voice storyboard before any spend", async () => {
    const fake = await setup("fake");
    await fake.handlers.plan(makeJob({ type: "plan", project_id: "p1", payload: FORM }), ctx);
    const real = await setup("real");
    const record = fake.db.storyboards[0];
    record.status = "approved";
    real.db.storyboards.push(record);
    await expect(real.handlers.generate(makeJob({ type: "generate", project_id: "p1", payload: { storyboardId: record.id } }), ctx)).rejects.toThrow(/fake-mode worker/);
    expect(real.providers.calls.voice + real.providers.calls.image + real.providers.calls.video).toBe(0);
  });

  it("fake mode: the generate handler refuses a storyboard with a real voice", async () => {
    const real = await setup("real");
    await real.handlers.plan(makeJob({ type: "plan", project_id: "p1", payload: FORM }), ctx);
    const record = real.db.storyboards[0];
    record.status = "approved";
    const fake = await setup("fake");
    fake.db.storyboards.push(record);
    await expect(fake.handlers.generate(makeJob({ type: "generate", project_id: "p1", payload: { storyboardId: record.id } }), ctx)).rejects.toThrow(/fake providers/);
    expect(fake.providers.calls.voice + fake.providers.calls.image + fake.providers.calls.video).toBe(0);
  });

  it("real mode: the plan handler uses the form's voice, else the language default, never the fake voice", async () => {
    const s = await setup("real");
    await s.handlers.plan(makeJob({ type: "plan", project_id: "p1", payload: { ...FORM, voiceId: "chosen" } }), ctx);
    await s.handlers.plan(makeJob({ type: "plan", project_id: "p2", payload: FORM }), ctx);
    const voices = s.db.storyboards.map((r) => (r.json as { voice: { voiceId: string } }).voice.voiceId);
    expect(voices).toEqual(["chosen", "voice-he"]);
  });
});
