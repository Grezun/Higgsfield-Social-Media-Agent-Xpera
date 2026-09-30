import { parseStoryboard } from "@reel/core";
import { describe, expect, it } from "vitest";
import { describeLength } from "./length-view";

const sb = (scripts: string[], target: 15 | 30 = 15) =>
  parseStoryboard({
    version: 1, title: "t", language: "he", format: "faceless", aspect: "9:16", targetDurationSec: target,
    voice: { voiceId: "v", modelId: "eleven_v4" },
    style: { captionPreset: "bold_pop", font: "Heebo", palette: ["#FFE14D"], pacing: "punchy" },
    scenes: scripts.map((script, i) => ({ id: `s${i + 1}`, script, visual: { kind: "graphic" }, overlays: [], transitionOut: "cut" })),
  });
const words = (n: number) => Array.from({ length: n }, () => "מילה").join(" ");

describe("describeLength", () => {
  it("shows the estimate against the target", () => {
    expect(describeLength(sb([words(23), words(11)]))).toEqual({ text: "Estimated length ≈ 15 s (target 15 s)", tooLong: false });
  });
  it("warns when more than 25% over", () => {
    const view = describeLength(sb(Array.from({ length: 6 }, () => words(10))));
    expect(view.tooLong).toBe(true);
    expect(view.text).toBe("Estimated length ≈ 26 s (target 15 s): too long; trim the voiceover or remove scenes.");
  });
  it("warns when over the scene cap even if under time", () => {
    const view = describeLength(sb(Array.from({ length: 7 }, () => words(2))));
    expect(view.tooLong).toBe(true);
    expect(view.text).toMatch(/^Estimated length ≈ \d+ s \(target 15 s\): too long; trim the voiceover or remove scenes\.$/);
  });
});
