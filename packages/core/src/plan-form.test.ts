import { describe, expect, it } from "vitest";
import { PlanFormSchema } from "./plan-form";

const valid = {
  brief: "3 טיפים לצמיחה בטיקטוק",
  language: "he",
  targetDurationSec: 30,
  pacing: "punchy",
  captionPreset: "bold_pop",
  palette: ["#FFE14D", "#111111"],
};

describe("PlanFormSchema", () => {
  it("accepts a valid form and leaves voiceId optional", () => {
    expect(PlanFormSchema.parse(valid)).toEqual(valid);
    expect(PlanFormSchema.parse({ ...valid, voiceId: " v1 " }).voiceId).toBe("v1");
  });
  it("rejects a too-short brief, bad length and bad colours", () => {
    expect(PlanFormSchema.safeParse({ ...valid, brief: "hi" }).success).toBe(false);
    expect(PlanFormSchema.safeParse({ ...valid, targetDurationSec: 20 }).success).toBe(false);
    expect(PlanFormSchema.safeParse({ ...valid, palette: ["yellow"] }).success).toBe(false);
  });
});
