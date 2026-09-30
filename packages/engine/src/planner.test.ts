import type { StoryboardDraft } from "@reel/core";
import { describe, expect, it, vi } from "vitest";
import { buildStoryboard, createPlanner, PlannerRefusedError, userPrompt, type DraftModel } from "./planner";
import type { PlanRequest } from "./providers/types";

const REQ: PlanRequest = {
  brief: "3 טיפים לצמיחה בטיקטוק",
  language: "he",
  targetDurationSec: 30,
  pacing: "punchy",
  captionPreset: "bold_pop",
  palette: ["#FFE14D", "#111111"],
  voice: { voiceId: "v1", modelId: "eleven_v4" },
};

const draft = (script = "הוק חזק"): StoryboardDraft => ({
  title: "טיפים",
  scenes: [
    { script, visual: { kind: "image", prompt: "phone on desk, soft light", motion: "zoom_in" }, overlays: [], transitionOut: "whip" },
    { script: "טיפ ראשון", visual: { kind: "graphic", prompt: "  ", motion: "none" }, overlays: [{ text: "טיפ 1", position: "top", animation: "pop" }], transitionOut: "cut" },
  ],
});

const reply = (d: StoryboardDraft | null, stopReason: string = "end_turn") => ({ stopReason, draft: d, raw: JSON.stringify(d) });

describe("buildStoryboard", () => {
  it("fills ids, request settings and drops blank graphic prompts", () => {
    const sb = buildStoryboard(draft(), REQ);
    expect(sb).toMatchObject({ version: 1, language: "he", format: "faceless", aspect: "9:16", targetDurationSec: 30, voice: REQ.voice });
    expect(sb.style).toEqual({ captionPreset: "bold_pop", font: "Heebo", palette: REQ.palette, pacing: "punchy" });
    expect(sb.scenes.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(sb.scenes[1].visual.prompt).toBeUndefined();
  });
});

describe("createPlanner", () => {
  it("returns the storyboard from a valid first answer", async () => {
    const model: DraftModel = vi.fn(async () => reply(draft()));
    const sb = await createPlanner(model).plan(REQ);
    expect(sb.scenes).toHaveLength(2);
    expect(model).toHaveBeenCalledTimes(1);
  });

  it("repairs once, sending the validation errors back", async () => {
    const model = vi.fn<DraftModel>().mockResolvedValueOnce(reply(draft("   "))).mockResolvedValueOnce(reply(draft()));
    const sb = await createPlanner(model).plan(REQ);
    expect(sb.scenes[0].script).toBe("הוק חזק");
    expect(model.mock.calls[1][0].user).toMatch(/scenes\.0\.script/);
  });

  it("repairs when the output did not parse at all", async () => {
    const model = vi.fn<DraftModel>().mockResolvedValueOnce(reply(null)).mockResolvedValueOnce(reply(draft()));
    await createPlanner(model).plan(REQ);
    expect(model.mock.calls[1][0].user).toMatch(/did not match the storyboard schema/);
  });

  it("throws after two invalid answers", async () => {
    const model: DraftModel = async () => reply(draft("   "));
    await expect(createPlanner(model).plan(REQ)).rejects.toThrow(/invalid storyboard twice/);
  });

  it("throws PlannerRefusedError on refusal without retrying", async () => {
    const model = vi.fn<DraftModel>(async () => reply(null, "refusal"));
    await expect(createPlanner(model).plan(REQ)).rejects.toBeInstanceOf(PlannerRefusedError);
    expect(model).toHaveBeenCalledTimes(1);
  });
});

describe("userPrompt", () => {
  it("states language, length and a word budget", () => {
    const p = userPrompt(REQ);
    expect(p).toMatch(/Hebrew/);
    expect(p).toMatch(/30 seconds, about 69 spoken words/);
    expect(p).toMatch(/about 10 scenes/);
  });
});

const longDraft = (): StoryboardDraft => ({
  title: "ארוך",
  scenes: Array.from({ length: 20 }, () => ({
    script: Array.from({ length: 12 }, () => "מילה").join(" "),
    visual: { kind: "graphic", prompt: "", motion: "none" },
    overlays: [],
    transitionOut: "cut",
  })),
});

describe("length enforcement", () => {
  it("asks Claude once to shorten an over-long storyboard and returns the fixed one", async () => {
    const model = vi.fn<DraftModel>().mockResolvedValueOnce(reply(longDraft())).mockResolvedValueOnce(reply(draft()));
    const sb = await createPlanner(model).plan(REQ);
    expect(model).toHaveBeenCalledTimes(2);
    expect(model.mock.calls[1][0].user).toMatch(/at most 12 scenes \(you wrote 20\)/);
    expect(sb.scenes).toHaveLength(2);
  });

  it("returns a still-long second answer instead of failing", async () => {
    const model = vi.fn<DraftModel>(async () => reply(longDraft()));
    const sb = await createPlanner(model).plan(REQ);
    expect(model).toHaveBeenCalledTimes(2);
    expect(sb.scenes).toHaveLength(20);
  });

  it("states hard limits in the prompt", () => {
    expect(userPrompt(REQ)).toMatch(/Hard limits: at most 12 scenes and about 69 spoken words/);
  });
});
