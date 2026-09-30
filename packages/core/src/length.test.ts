import { describe, expect, it } from "vitest";
import { estimateStoryboardSeconds, lengthIssues, maxScenesFor, targetWordsFor } from "./length";

const scene = (script: string) => ({ id: "s", script, visual: { kind: "graphic" as const, motion: "none" as const }, overlays: [], transitionOut: "cut" as const });
const words = (n: number) => Array.from({ length: n }, () => "מילה").join(" ");

describe("length", () => {
  it("derives limits from the target", () => {
    expect(maxScenesFor(15)).toBe(6);
    expect(maxScenesFor(30)).toBe(12);
    expect(targetWordsFor(15, "he")).toBe(35);
    expect(targetWordsFor(30, "en")).toBe(78);
  });

  it("estimates seconds per scene with a 2 s floor", () => {
    expect(estimateStoryboardSeconds({ language: "he", scenes: [scene(words(23)), scene("היי")] })).toBeCloseTo(12, 5);
  });

  it("flags too much speech and too many scenes, with actionable numbers", () => {
    const long = { language: "he" as const, targetDurationSec: 15 as const, scenes: Array.from({ length: 10 }, () => scene(words(8))) };
    const issues = lengthIssues(long);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatch(/about 3\d s of speech.*target is 15 s.*about 35 words/);
    expect(issues[1]).toMatch(/at most 6 scenes \(you wrote 10\)/);
  });

  it("accepts a storyboard within 25% of the target", () => {
    expect(lengthIssues({ language: "en", targetDurationSec: 15, scenes: [scene(words(20)), scene(words(20))] })).toEqual([]);
  });
});
