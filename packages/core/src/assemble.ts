import type { Storyboard } from "./schema/storyboard";
import { TimelineSchema, type Timeline, type TimelineClip, type TimelineOverlay, type Word } from "./schema/timeline";
import type { SceneSpan } from "./spans";

export const FPS = 30;
export const DEFAULT_TAIL_MS = 400;
export const MUSIC_DUCKING_DB = -18;

export type SceneVisual = { kind: "video" | "image"; src: string };
export type AssembleInput = {
  storyboard: Storyboard;
  spans: SceneSpan[];
  words: Word[];
  visuals: Record<string, SceneVisual>;
  voiceUrl?: string;
  musicUrl?: string;
  tailMs?: number;
};

const msToFrame = (ms: number) => Math.round((ms * FPS) / 1000);

export function assemble(input: AssembleInput): Timeline {
  const { storyboard: sb, spans } = input;
  if (spans.length !== sb.scenes.length) {
    throw new Error(`expected ${sb.scenes.length} spans, got ${spans.length}`);
  }
  const totalMs = spans[spans.length - 1].endMs + (input.tailMs ?? DEFAULT_TAIL_MS);
  const durationInFrames = Math.ceil((totalMs * FPS) / 1000);
  const starts = spans.map((s, i) => (i === 0 ? 0 : msToFrame(s.startMs)));

  const clips: TimelineClip[] = [];
  const overlays: TimelineOverlay[] = [];
  sb.scenes.forEach((scene, i) => {
    const fromFrame = starts[i];
    const clipFrames = (i === sb.scenes.length - 1 ? durationInFrames : starts[i + 1]) - fromFrame;
    const transitionIn = i === 0 ? "cut" : sb.scenes[i - 1].transitionOut;
    if (scene.visual.kind === "graphic") {
      clips.push({ sceneId: scene.id, kind: "graphic", fromFrame, durationInFrames: clipFrames, motion: scene.visual.motion, transitionIn });
    } else {
      const visual = input.visuals[scene.id];
      if (!visual) throw new Error(`missing visual for scene "${scene.id}"`);
      clips.push({ sceneId: scene.id, kind: visual.kind, src: visual.src, fromFrame, durationInFrames: clipFrames, motion: scene.visual.motion, transitionIn });
    }
    const n = scene.overlays.length;
    scene.overlays.forEach((overlay, j) => {
      const oFrom = fromFrame + Math.floor((clipFrames * j) / n);
      const oEnd = fromFrame + Math.floor((clipFrames * (j + 1)) / n);
      overlays.push({ ...overlay, fromFrame: oFrom, durationInFrames: Math.max(1, oEnd - oFrom) });
    });
  });

  return TimelineSchema.parse({
    fps: FPS,
    width: 1080,
    height: 1920,
    durationInFrames,
    language: sb.language,
    direction: sb.language === "he" ? "rtl" : "ltr",
    style: { captionPreset: sb.style.captionPreset, font: sb.style.font, palette: sb.style.palette },
    audio: { voiceUrl: input.voiceUrl, musicUrl: input.musicUrl, musicDuckingDb: MUSIC_DUCKING_DB },
    clips,
    captions: { words: input.words },
    overlays,
  });
}
