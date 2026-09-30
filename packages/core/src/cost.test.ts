import { describe, expect, it } from "vitest";
import { assertWithinCap, estimateCost, estimateSceneSeconds, videoBillSeconds } from "./cost";
import { SpendCapError, UnknownCostModelError } from "./errors";
import { parseStoryboard } from "./schema/storyboard";
import { validStoryboard } from "./testing/fixtures";

const MODELS = {
  image: "higgsfield-ai/soul/v2/standard",
  video: "bytedance/seedance-2.5/image-to-video",
  voice: "elevenlabs/eleven_v4",
};

describe("cost", () => {
  it("videoBillSeconds clamps to the 4–30 s integer range Seedance accepts", () => {
    expect(videoBillSeconds(1.2)).toBe(4);
    expect(videoBillSeconds(6.1)).toBe(7);
    expect(videoBillSeconds(45)).toBe(30);
  });

  it("estimateSceneSeconds is at least 2 s and grows with words", () => {
    expect(estimateSceneSeconds("hi", "en")).toBe(2);
    expect(estimateSceneSeconds(Array(26).fill("w").join(" "), "en")).toBeCloseTo(10, 0);
  });

  it("charges image scenes one image, broll one image plus video seconds, graphic nothing, voice per char", () => {
    const input = validStoryboard();
    input.scenes[1].visual = { kind: "broll_video", prompt: "city", motion: "none" } as never;
    const est = estimateCost(parseStoryboard(input), MODELS, {
      [MODELS.image]: { perImage: 0.1 },
      [MODELS.video]: { perSecond: 0.05 },
      [MODELS.voice]: { per1kChars: 1 },
    });
    const items = est.lines.map((l) => l.item);
    expect(items).toEqual(["image s1", "image s2", "video s2", "voice"]);
    expect(est.lines[2].quantity).toBe(4);
    expect(est.totalUsd).toBeCloseTo(0.1 + 0.1 + 0.2 + (est.lines[3].quantity / 1000) * 1, 5);
  });

  it("throws UnknownCostModelError when a model has no price", () => {
    expect(() => estimateCost(parseStoryboard(validStoryboard()), { ...MODELS, image: "nope" }, {})).toThrow(
      UnknownCostModelError,
    );
  });

  it("assertWithinCap throws SpendCapError over the cap", () => {
    expect(() => assertWithinCap({ totalUsd: 11, lines: [] }, 10)).toThrow(SpendCapError);
    expect(() => assertWithinCap({ totalUsd: 9, lines: [] }, 10)).not.toThrow();
  });
});
