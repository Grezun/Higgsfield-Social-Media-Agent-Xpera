import { describe, expect, it } from "vitest";
import { validStoryboard } from "../testing/fixtures";
import { parseStoryboard } from "./storyboard";

describe("StoryboardSchema", () => {
  it("accepts a valid faceless storyboard and applies defaults", () => {
    const input = validStoryboard();
    delete (input.scenes[1] as { overlays?: unknown }).overlays;
    const sb = parseStoryboard(input);
    expect(sb.scenes[1].overlays).toEqual([]);
    expect(sb.scenes[1].visual.motion).toBe("none");
  });

  it("rejects an empty script with a readable message naming the path", () => {
    const input = validStoryboard();
    input.scenes[0].script = "   ";
    expect(() => parseStoryboard(input)).toThrow(/scenes\.0\.script/);
  });

  it("rejects avatar scenes in a faceless reel", () => {
    const input = validStoryboard();
    input.scenes[0].visual = { kind: "avatar", prompt: "x", motion: "none" } as never;
    expect(() => parseStoryboard(input)).toThrow(/not allowed in a faceless reel/);
  });

  it("rejects duplicate scene ids", () => {
    const input = validStoryboard();
    input.scenes[1].id = "s1";
    expect(() => parseStoryboard(input)).toThrow(/duplicate scene id "s1"/);
  });

  it("requires a prompt for image and broll_video scenes", () => {
    const input = validStoryboard();
    delete (input.scenes[0].visual as { prompt?: string }).prompt;
    expect(() => parseStoryboard(input)).toThrow(/needs a visual\.prompt/);
  });

  it("requires a voice unless the format is footage", () => {
    const input = { ...validStoryboard(), voice: null };
    expect(() => parseStoryboard(input)).toThrow(/voice is required/);
  });
});
