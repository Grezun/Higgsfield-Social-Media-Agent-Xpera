import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { lengthIssues, maxScenesFor, parseStoryboard, StoryboardDraftSchema, targetWordsFor, type Storyboard, type StoryboardDraft } from "@reel/core";
import type { PlanRequest, Planner } from "./providers/types";

export type DraftModel = (req: { system: string; user: string }) => Promise<{
  stopReason: string | null;
  draft: StoryboardDraft | null;
  raw: string;
}>;

export class PlannerRefusedError extends Error {
  constructor() {
    super("Claude declined to write this storyboard. Rephrase the brief and try again.");
    this.name = "PlannerRefusedError";
  }
}

export function claudeDraftModel(client: Anthropic, model: string): DraftModel {
  return async ({ system, user }) => {
    const res = await client.beta.messages.parse({
      model,
      max_tokens: 16000,
      // On a safety decline, the API re-runs the request on a fallback model inside the same call.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "high", format: betaZodOutputFormat(StoryboardDraftSchema) },
      system,
      messages: [{ role: "user", content: user }],
    });
    const raw = res.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    return { stopReason: res.stop_reason, draft: res.parsed_output ?? null, raw };
  };
}

export function systemPrompt(): string {
  return [
    "You write storyboards for short vertical social videos (Instagram Reels, TikTok, YouTube Shorts).",
    "A storyboard is a list of scenes. Each scene has the voiceover line spoken during it, one visual, optional on-screen text overlays, and the transition into the next scene.",
    "",
    "What makes a strong reel:",
    "- Scene 1 is the hook: a bold claim, question, or surprising number within the first 2 seconds. No greetings or channel intros.",
    "- One idea per scene. Voiceover lines are short, spoken, conversational sentences, not written prose.",
    "- End with a clear payoff or call to action.",
    "",
    "Visuals:",
    '- kind "image": a still the editor animates with a slow camera move; set motion to zoom_in, zoom_out, pan_left or pan_right.',
    '- kind "broll_video": a moving shot for action and atmosphere. It costs more, so use it for at most half of the scenes.',
    '- kind "graphic": a plain branded background for text-heavy moments (lists, numbers); put the key text in an overlay and leave prompt empty.',
    "- Write every visual prompt in English, even for Hebrew reels, as a concrete photographic description: subject, setting, lighting, camera angle, vertical 9:16 framing. Never ask for text, captions, logos or watermarks inside the image.",
    "",
    "Overlays: at most 2 per scene, each under 6 words, in the reel's language. Voiceover captions are added automatically, so overlays must not repeat the voiceover.",
    'Transitions: mostly "cut"; use "whip" or "zoom" for energy and "fade" for calm moments.',
  ].join("\n");
}

export function userPrompt(req: PlanRequest): string {
  const words = targetWordsFor(req.targetDurationSec, req.language);
  const scenes = Math.max(3, Math.round(req.targetDurationSec / (req.pacing === "punchy" ? 3 : 5)));
  return [
    `Brief: ${req.brief}`,
    `Language of the voiceover and overlays: ${req.language === "he" ? "Hebrew" : "English"}.`,
    `Target length: ${req.targetDurationSec} seconds, about ${words} spoken words in total, about ${scenes} scenes.`,
    `Stay within ${maxScenesFor(req.targetDurationSec)} scenes and about ${targetWordsFor(req.targetDurationSec, req.language)} spoken words in total.`,
    `Pacing: ${req.pacing}.`,
    "Keep each scene's voiceover under 400 characters.",
  ].join("\n");
}

export function buildStoryboard(draft: StoryboardDraft, req: PlanRequest): Storyboard {
  return parseStoryboard({
    version: 1,
    title: draft.title,
    language: req.language,
    format: "faceless",
    aspect: "9:16",
    targetDurationSec: req.targetDurationSec,
    voice: req.voice,
    style: { captionPreset: req.captionPreset, font: "Heebo", palette: req.palette, pacing: req.pacing },
    scenes: draft.scenes.map((scene, i) => ({
      id: `s${i + 1}`,
      script: scene.script,
      visual: { kind: scene.visual.kind, prompt: scene.visual.prompt.trim() || undefined, motion: scene.visual.motion },
      overlays: scene.overlays.slice(0, 2),
      transitionOut: scene.transitionOut,
    })),
  });
}

type Attempt =
  | { ok: true; storyboard: Storyboard }
  | { ok: false; error: string; storyboard?: Storyboard };

function attempt(result: Awaited<ReturnType<DraftModel>>, req: PlanRequest): Attempt {
  if (result.stopReason === "refusal") throw new PlannerRefusedError();
  if (!result.draft) return { ok: false, error: "The output did not match the storyboard schema." };
  let storyboard: Storyboard;
  try {
    storyboard = buildStoryboard(result.draft, req);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const issues = lengthIssues(storyboard);
  return issues.length ? { ok: false, error: issues.join("\n"), storyboard } : { ok: true, storyboard };
}

export function createPlanner(model: DraftModel): Planner {
  return {
    async plan(req) {
      const system = systemPrompt();
      const user = userPrompt(req);
      const first = await model({ system, user });
      const firstAttempt = attempt(first, req);
      if (firstAttempt.ok) return firstAttempt.storyboard;

      const repairUser = [
        user,
        "",
        "Your previous storyboard was rejected:",
        firstAttempt.error,
        "",
        "Previous output:",
        first.raw,
        "",
        "Return a corrected storyboard.",
      ].join("\n");
      const second = attempt(await model({ system, user: repairUser }), req);
      if (second.ok) return second.storyboard;
      // Valid but still over length: return it — the editor shows the length warning.
      const fallback = second.storyboard ?? firstAttempt.storyboard;
      if (fallback) return fallback;
      throw new Error(`Claude returned an invalid storyboard twice:\n${second.error}`);
    },
  };
}
