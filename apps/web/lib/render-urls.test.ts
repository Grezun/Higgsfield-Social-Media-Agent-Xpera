import { assetSrc, type Timeline } from "@reel/core";
import { describe, expect, it } from "vitest";
import { signRender, type SigningClient } from "./render-urls";

const timeline: Timeline = {
  fps: 30, width: 1080, height: 1920, durationInFrames: 60, language: "en", direction: "ltr",
  style: { captionPreset: "clean", font: "Heebo", palette: ["#FFE14D"] },
  audio: { voiceUrl: assetSrc("v.wav"), musicDuckingDb: -18 },
  clips: [{ sceneId: "s1", kind: "image", src: assetSrc("a.png"), fromFrame: 0, durationInFrames: 60, motion: "none", transitionIn: "cut" }],
  captions: { words: [] },
  overlays: [],
};
const render = { reel_path: "p/v1/reel.mp4", preview_path: "p/v1/preview.mp4", thumbnail_path: "p/v1/thumbnail.jpg", timeline };

function fakeClient(missing: string[] = []): SigningClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async createSignedUrls(bucket, paths) {
      calls.push(`many:${bucket}:${paths.sort().join(",")}`);
      return Object.fromEntries(paths.filter((p) => !missing.includes(p)).map((p) => [p, `https://signed/${bucket}/${p}`]));
    },
    async createSignedUrl(bucket, path, _ttl, download) {
      calls.push(`one:${bucket}:${path}:${download ?? ""}`);
      return `https://signed/${bucket}/${path}`;
    },
  };
}

describe("signRender", () => {
  it("signs every asset ref in one batch and the deliverables, with a download name for the reel", async () => {
    const client = fakeClient();
    const signed = await signRender(client, render);
    expect(signed.timeline.audio.voiceUrl).toBe("https://signed/assets/v.wav");
    expect(signed.timeline.clips[0].src).toBe("https://signed/assets/a.png");
    expect(signed.reelUrl).toBe("https://signed/renders/p/v1/reel.mp4");
    expect(client.calls).toContain("many:assets:a.png,v.wav");
    expect(client.calls).toContain("one:renders:p/v1/reel.mp4:reel.mp4");
  });
  it("fails clearly when an asset can't be signed", async () => {
    await expect(signRender(fakeClient(["a.png"]), render)).rejects.toThrow(/a\.png/);
  });
});
