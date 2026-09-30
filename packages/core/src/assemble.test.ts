import { describe, expect, it } from "vitest";
import { assemble } from "./assemble";
import { parseStoryboard } from "./schema/storyboard";
import { validStoryboard } from "./testing/fixtures";

const sb = () => {
  const input = validStoryboard();
  input.scenes.push({
    id: "s3",
    script: "Third",
    visual: { kind: "broll_video", prompt: "city", motion: "pan_left" },
    overlays: [
      { text: "A", position: "top", animation: "fade" },
      { text: "B", position: "bottom", animation: "type" },
    ],
    transitionOut: "cut",
  } as never);
  input.scenes[1].transitionOut = "whip";
  return parseStoryboard(input);
};

const spans = [
  { sceneIndex: 0, startMs: 0, endMs: 1000 },
  { sceneIndex: 1, startMs: 1000, endMs: 2500 },
  { sceneIndex: 2, startMs: 2500, endMs: 4000 },
];
const visuals = {
  s1: { kind: "image" as const, src: "http://x/s1.png" },
  s3: { kind: "video" as const, src: "http://x/s3.mp4" },
};

describe("assemble", () => {
  it("lays clips contiguously on audio spans and adds the tail to the last clip", () => {
    const t = assemble({ storyboard: sb(), spans, words: [], visuals, voiceUrl: "http://x/v.wav" });
    expect(t.durationInFrames).toBe(132); // (4000 + 400) ms × 30 fps
    expect(t.clips.map((c) => [c.fromFrame, c.durationInFrames])).toEqual([[0, 30], [30, 45], [75, 57]]);
    expect(t.clips.reduce((n, c) => n + c.durationInFrames, 0)).toBe(t.durationInFrames);
  });

  it("maps kinds, sources and carries the previous transitionOut as transitionIn", () => {
    const t = assemble({ storyboard: sb(), spans, words: [], visuals });
    expect(t.clips.map((c) => [c.kind, c.src, c.transitionIn])).toEqual([
      ["image", "http://x/s1.png", "cut"],
      ["graphic", undefined, "fade"],
      ["video", "http://x/s3.mp4", "whip"],
    ]);
  });

  it("sets rtl for Hebrew and copies style", () => {
    const t = assemble({ storyboard: sb(), spans, words: [], visuals });
    expect(t.direction).toBe("rtl");
    expect(t.style).toEqual({ captionPreset: "bold_pop", font: "Heebo", palette: ["#FFE14D", "#111111"] });
  });

  it("splits a scene's overlays evenly across the scene", () => {
    const t = assemble({ storyboard: sb(), spans, words: [], visuals });
    const s3 = t.overlays.filter((o) => o.fromFrame >= 75);
    expect(s3.map((o) => [o.text, o.fromFrame, o.durationInFrames])).toEqual([["A", 75, 28], ["B", 103, 29]]);
  });

  it("throws when a non-graphic scene has no visual", () => {
    expect(() => assemble({ storyboard: sb(), spans, words: [], visuals: { s1: visuals.s1 } })).toThrow(
      /missing visual for scene "s3"/,
    );
  });
});
