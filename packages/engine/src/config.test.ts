import { describe, expect, it } from "vitest";
import { costModels, loadConfig, REPO_ROOT, requireRealCredentials } from "./config";

describe("loadConfig", () => {
  it("applies defaults", () => {
    const c = loadConfig({});
    expect(c.providers).toBe("real");
    expect(c.cacheDir).toBe(`${REPO_ROOT}/.reel-cache`);
    expect(c.spendCapUsd).toBe(10);
    expect(c.claudeModel).toBe("claude-opus-5-5");
    expect(c.elevenlabs.modelId).toBe("eleven_v4");
    expect(c.higgsfield).toMatchObject({ concurrency: 4, videoResolution: "720p", baseUrl: "https://api.higgsfield.ai" });
    expect(costModels(c)).toEqual({
      image: "higgsfield-ai/soul/v2/standard",
      video: "bytedance/seedance-2.5/image-to-video",
      voice: "elevenlabs/eleven_v4",
    });
  });

  it("rejects bad values with a clear message", () => {
    expect(() => loadConfig({ HF_VIDEO_RESOLUTION: "4k" })).toThrow(/HF_VIDEO_RESOLUTION/);
    expect(() => loadConfig({ REEL_SPEND_CAP_USD: "-1" })).toThrow(/REEL_SPEND_CAP_USD/);
    expect(() => loadConfig({ HF_CONCURRENCY: "0" })).toThrow(/HF_CONCURRENCY/);
  });

  it("lists every missing credential for real providers", () => {
    expect(() => requireRealCredentials(loadConfig({}))).toThrow(/HF_CREDENTIALS[\s\S]*ELEVENLABS_API_KEY/);
    expect(() => requireRealCredentials(loadConfig({ HF_CREDENTIALS: "a:b", ELEVENLABS_API_KEY: "k" }))).not.toThrow();
  });
});
