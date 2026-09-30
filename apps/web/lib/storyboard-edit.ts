import { parseStoryboard, type Scene, type Storyboard } from "@reel/core";

export const MAX_OVERLAYS = 3;

export type ScenePatch = Partial<Pick<Scene, "script" | "transitionOut">> & { visual?: Partial<Scene["visual"]> };
export type OverlayPatch = Partial<Scene["overlays"][number]>;

export type EditAction =
  | { type: "updateScene"; index: number; patch: ScenePatch }
  | { type: "addScene"; after: number }
  | { type: "removeScene"; index: number }
  | { type: "moveScene"; index: number; direction: -1 | 1 }
  | { type: "addOverlay"; sceneIndex: number }
  | { type: "updateOverlay"; sceneIndex: number; overlayIndex: number; patch: OverlayPatch }
  | { type: "removeOverlay"; sceneIndex: number; overlayIndex: number }
  | { type: "reset"; storyboard: Storyboard };

export function newSceneId(existing: string[]): string {
  for (let n = existing.length + 1; ; n++) {
    const id = `s${n}`;
    if (!existing.includes(id)) return id;
  }
}

const withScene = (sb: Storyboard, index: number, update: (s: Scene) => Scene): Storyboard => {
  const scene = sb.scenes[index];
  if (!scene) return sb;
  const scenes = [...sb.scenes];
  scenes[index] = update(scene);
  return { ...sb, scenes };
};

export function editStoryboard(sb: Storyboard, action: EditAction): Storyboard {
  switch (action.type) {
    case "updateScene":
      return withScene(sb, action.index, (s) => ({ ...s, ...action.patch, visual: { ...s.visual, ...action.patch.visual } }));
    case "addScene": {
      const scenes = [...sb.scenes];
      scenes.splice(action.after + 1, 0, {
        id: newSceneId(sb.scenes.map((s) => s.id)),
        script: "",
        visual: { kind: "image", prompt: "", motion: "zoom_in" },
        overlays: [],
        transitionOut: "cut",
      });
      return { ...sb, scenes };
    }
    case "removeScene": {
      if (sb.scenes.length <= 1 || !sb.scenes[action.index]) return sb;
      return { ...sb, scenes: sb.scenes.filter((_, i) => i !== action.index) };
    }
    case "moveScene": {
      const j = action.index + action.direction;
      if (j < 0 || j >= sb.scenes.length || !sb.scenes[action.index]) return sb;
      const scenes = [...sb.scenes];
      [scenes[action.index], scenes[j]] = [scenes[j], scenes[action.index]];
      return { ...sb, scenes };
    }
    case "addOverlay":
      return withScene(sb, action.sceneIndex, (s) =>
        s.overlays.length >= MAX_OVERLAYS ? s : { ...s, overlays: [...s.overlays, { text: "", position: "top", animation: "pop" }] });
    case "updateOverlay":
      return withScene(sb, action.sceneIndex, (s) => ({
        ...s,
        overlays: s.overlays.map((o, i) => (i === action.overlayIndex ? { ...o, ...action.patch } : o)),
      }));
    case "removeOverlay":
      return withScene(sb, action.sceneIndex, (s) => ({ ...s, overlays: s.overlays.filter((_, i) => i !== action.overlayIndex) }));
    case "reset":
      return action.storyboard;
  }
}

/** Blank prompts mean "no prompt" (graphic scenes); the schema requires a present prompt to be non-empty. */
export function normalizeForSave(sb: Storyboard): Storyboard {
  return {
    ...sb,
    scenes: sb.scenes.map((s) => {
      const prompt = s.visual.prompt?.trim();
      const { prompt: _drop, ...visual } = s.visual;
      return { ...s, visual: prompt ? { ...visual, prompt } : visual };
    }),
  };
}

export type StoryboardCheck = { ok: true; storyboard: Storyboard } | { ok: false; errors: string[] };

export function checkStoryboard(input: unknown): StoryboardCheck {
  try {
    const candidate = typeof input === "object" && input !== null && "scenes" in input ? normalizeForSave(input as Storyboard) : input;
    return { ok: true, storyboard: parseStoryboard(candidate) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const lines = message.split("\n").slice(1).map((l) => l.replace(/^\s*-\s*/, "").trim()).filter(Boolean);
    return { ok: false, errors: lines.length ? lines : [message] };
  }
}
