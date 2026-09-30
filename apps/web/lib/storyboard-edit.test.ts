import { parseStoryboard } from "@reel/core";
import { describe, expect, it } from "vitest";
import { checkStoryboard, editStoryboard, newSceneId, normalizeForSave } from "./storyboard-edit";

const sb = () =>
  parseStoryboard({
    version: 1, title: "t", language: "he", format: "faceless", aspect: "9:16", targetDurationSec: 30,
    voice: { voiceId: "v", modelId: "eleven_v4" },
    style: { captionPreset: "bold_pop", font: "Heebo", palette: ["#FFE14D"], pacing: "punchy" },
    scenes: [
      { id: "s1", script: "הוק", visual: { kind: "image", prompt: "phone", motion: "zoom_in" }, overlays: [], transitionOut: "cut" },
      { id: "s2", script: "טיפ", visual: { kind: "graphic" }, overlays: [], transitionOut: "cut" },
    ],
  });

describe("editStoryboard", () => {
  it("patches a scene's script and visual without touching other fields", () => {
    const next = editStoryboard(sb(), { type: "updateScene", index: 0, patch: { script: "חדש", visual: { prompt: "desk" } } });
    expect(next.scenes[0]).toMatchObject({ script: "חדש", visual: { kind: "image", prompt: "desk", motion: "zoom_in" } });
    expect(next.scenes[1]).toEqual(sb().scenes[1]);
  });
  it("adds a scene after an index with a fresh id and removes/moves scenes", () => {
    let s = editStoryboard(sb(), { type: "addScene", after: 0 });
    expect(s.scenes.map((x) => x.id)).toEqual(["s1", "s3", "s2"]);
    s = editStoryboard(s, { type: "moveScene", index: 2, direction: -1 });
    expect(s.scenes.map((x) => x.id)).toEqual(["s1", "s2", "s3"]);
    s = editStoryboard(s, { type: "removeScene", index: 0 });
    expect(s.scenes.map((x) => x.id)).toEqual(["s2", "s3"]);
  });
  it("never removes the last scene or moves past the ends", () => {
    const one = editStoryboard(sb(), { type: "removeScene", index: 1 });
    expect(editStoryboard(one, { type: "removeScene", index: 0 }).scenes).toHaveLength(1);
    expect(editStoryboard(sb(), { type: "moveScene", index: 0, direction: -1 })).toEqual(sb());
  });
  it("adds (max 3), edits and removes overlays", () => {
    let s = sb();
    for (let i = 0; i < 4; i++) s = editStoryboard(s, { type: "addOverlay", sceneIndex: 0 });
    expect(s.scenes[0].overlays).toHaveLength(3);
    s = editStoryboard(s, { type: "updateOverlay", sceneIndex: 0, overlayIndex: 1, patch: { text: "טיפ 1" } });
    expect(s.scenes[0].overlays[1].text).toBe("טיפ 1");
    s = editStoryboard(s, { type: "removeOverlay", sceneIndex: 0, overlayIndex: 0 });
    expect(s.scenes[0].overlays).toHaveLength(2);
  });
  it("newSceneId skips ids in use", () => {
    expect(newSceneId(["s1", "s3"])).toBe("s4");
    expect(newSceneId([])).toBe("s1");
  });
});

describe("checkStoryboard", () => {
  it("drops blank prompts before validating (graphic scenes)", () => {
    const s = editStoryboard(sb(), { type: "updateScene", index: 1, patch: { visual: { prompt: "  " } } });
    expect(normalizeForSave(s).scenes[1].visual.prompt).toBeUndefined();
    expect(checkStoryboard(s).ok).toBe(true);
  });
  it("returns one readable line per problem", () => {
    let s = editStoryboard(sb(), { type: "updateScene", index: 0, patch: { script: "", visual: { prompt: "" } } });
    s = editStoryboard(s, { type: "addOverlay", sceneIndex: 1 });
    const r = checkStoryboard(s);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.length).toBeGreaterThanOrEqual(2);
    expect(!r.ok && r.errors.join("\n")).toMatch(/scenes\.0\.script/);
    expect(!r.ok && r.errors.every((e) => !e.startsWith("-"))).toBe(true);
  });
});
