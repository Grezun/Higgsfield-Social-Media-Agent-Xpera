import { describe, expect, it } from "vitest";
import { assetSrc, mapTimelineSources, timelineAssetFiles } from "./timeline-sources";
import type { Timeline } from "./schema/timeline";

const timeline = (): Timeline => ({
  fps: 30, width: 1080, height: 1920, durationInFrames: 60, language: "he", direction: "rtl",
  style: { captionPreset: "bold_pop", font: "Heebo", palette: ["#FFE14D"] },
  audio: { voiceUrl: assetSrc("v.wav"), musicDuckingDb: -18 },
  clips: [
    { sceneId: "s1", kind: "image", src: assetSrc("a.png"), fromFrame: 0, durationInFrames: 30, motion: "none", transitionIn: "cut" },
    { sceneId: "s2", kind: "graphic", fromFrame: 30, durationInFrames: 30, motion: "none", transitionIn: "cut" },
    { sceneId: "s3", kind: "video", src: "https://already/abs.mp4", fromFrame: 30, durationInFrames: 30, motion: "none", transitionIn: "cut" },
  ],
  captions: { words: [] },
  overlays: [],
});

describe("timeline sources", () => {
  it("lists referenced asset files once each", () => {
    expect(timelineAssetFiles(timeline()).sort()).toEqual(["a.png", "v.wav"]);
  });
  it("resolves asset: refs and leaves other srcs alone", () => {
    const t = mapTimelineSources(timeline(), (f) => `https://signed/${f}`);
    expect(t.audio.voiceUrl).toBe("https://signed/v.wav");
    expect(t.clips.map((c) => c.src)).toEqual(["https://signed/a.png", undefined, "https://already/abs.mp4"]);
    expect(t.audio.musicUrl).toBeUndefined();
  });
});
