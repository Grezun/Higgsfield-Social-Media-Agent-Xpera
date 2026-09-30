import * as z from "zod";

export const LanguageSchema = z.enum(["he", "en"]);
export type Language = z.infer<typeof LanguageSchema>;

export const MotionSchema = z.enum(["none", "zoom_in", "zoom_out", "pan_left", "pan_right"]);
export const TransitionSchema = z.enum(["cut", "fade", "whip", "zoom"]);
export const OverlayPositionSchema = z.enum(["top", "center", "bottom"]);
export const OverlayAnimationSchema = z.enum(["pop", "fade", "type"]);
export const VisualKindSchema = z.enum(["broll_video", "image", "avatar", "footage", "graphic"]);
export const CaptionPresetSchema = z.enum(["bold_pop", "clean"]);
export const FormatSchema = z.enum(["faceless", "avatar", "character", "footage"]);

const FACELESS_KINDS = new Set(["broll_video", "image", "graphic"]);
const PROMPTED_KINDS = new Set(["broll_video", "image"]);
// 20 scenes × 400 chars keeps one TTS request well under eleven_v4's 10k-character limit.

const OverlaySchema = z.object({
  text: z.string().trim().min(1).max(80),
  position: OverlayPositionSchema,
  animation: OverlayAnimationSchema,
});

export const SceneSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/i, "scene id may only contain letters, digits, _ and -"),
  script: z.string().trim().min(1).max(400),
  footageSpan: z
    .object({ startMs: z.number().int().nonnegative(), endMs: z.number().int().positive() })
    .optional(),
  visual: z.object({
    kind: VisualKindSchema,
    prompt: z.string().trim().min(1).max(1500).optional(),
    model: z.string().min(1).optional(),
    motion: MotionSchema.default("none"),
  }),
  overlays: z.array(OverlaySchema).max(3).default([]),
  transitionOut: TransitionSchema.default("cut"),
});
export type Scene = z.infer<typeof SceneSchema>;

export const StoryboardSchema = z
  .object({
    version: z.number().int().positive(),
    title: z.string().trim().min(1).max(120),
    language: LanguageSchema,
    format: FormatSchema,
    aspect: z.literal("9:16"),
    targetDurationSec: z.union([z.literal(15), z.literal(30), z.literal(45), z.literal(60)]),
    voice: z
      .object({
        voiceId: z.string().min(1),
        modelId: z.string().min(1),
        stability: z.number().min(0).max(1).optional(),
        style: z.number().min(0).max(1).optional(),
      })
      .nullable(),
    character: z.object({ customReferenceId: z.string().min(1) }).optional(),
    sourceFootageAssetId: z.string().min(1).optional(),
    style: z.object({
      captionPreset: CaptionPresetSchema,
      font: z.string().min(1).default("Heebo"),
      palette: z.array(z.string().regex(/^#[0-9a-f]{6}$/i, "palette colors must be #RRGGBB")).min(1).max(5),
      musicAssetId: z.string().min(1).optional(),
      pacing: z.enum(["calm", "punchy"]),
    }),
    scenes: z.array(SceneSchema).min(1).max(20),
  })
  .superRefine((sb, ctx) => {
    const seen = new Set<string>();
    sb.scenes.forEach((scene, i) => {
      if (seen.has(scene.id)) {
        ctx.addIssue({ code: "custom", path: ["scenes", i, "id"], message: `duplicate scene id "${scene.id}"` });
      }
      seen.add(scene.id);
      if (sb.format === "faceless" && !FACELESS_KINDS.has(scene.visual.kind)) {
        ctx.addIssue({
          code: "custom",
          path: ["scenes", i, "visual", "kind"],
          message: `visual kind "${scene.visual.kind}" is not allowed in a faceless reel`,
        });
      }
      if (PROMPTED_KINDS.has(scene.visual.kind) && !scene.visual.prompt) {
        ctx.addIssue({
          code: "custom",
          path: ["scenes", i, "visual", "prompt"],
          message: `scene "${scene.id}" (${scene.visual.kind}) needs a visual.prompt`,
        });
      }
    });
    if (sb.format !== "footage" && sb.voice === null) {
      ctx.addIssue({ code: "custom", path: ["voice"], message: `voice is required for the ${sb.format} format` });
    }
  });
export type Storyboard = z.infer<typeof StoryboardSchema>;

/** Parses a storyboard, throwing an Error whose message lists every issue as "path: message". */
export function parseStoryboard(input: unknown): Storyboard {
  const result = StoryboardSchema.safeParse(input);
  if (result.success) return result.data;
  const lines = result.error.issues.map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  throw new Error(`Invalid storyboard:\n${lines.join("\n")}`);
}

/**
 * The subset Claude writes. Deliberately free of min/max constraints (structured outputs
 * do not enforce them); the full StoryboardSchema validates afterwards.
 */
export const StoryboardDraftSchema = z.object({
  title: z.string(),
  scenes: z.array(
    z.object({
      script: z.string(),
      visual: z.object({
        kind: z.enum(["broll_video", "image", "graphic"]),
        prompt: z.string(),
        motion: MotionSchema,
      }),
      overlays: z.array(
        z.object({ text: z.string(), position: OverlayPositionSchema, animation: OverlayAnimationSchema }),
      ),
      transitionOut: TransitionSchema,
    }),
  ),
});
export type StoryboardDraft = z.infer<typeof StoryboardDraftSchema>;
