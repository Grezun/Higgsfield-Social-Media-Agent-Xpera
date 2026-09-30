import * as z from "zod";
import {
  CaptionPresetSchema,
  LanguageSchema,
  MotionSchema,
  OverlayAnimationSchema,
  OverlayPositionSchema,
  TransitionSchema,
} from "./storyboard";

export const WordSchema = z.object({
  text: z.string().min(1),
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
});
export type Word = z.infer<typeof WordSchema>;

export const TimelineClipSchema = z.object({
  sceneId: z.string(),
  kind: z.enum(["video", "image", "graphic"]),
  src: z.string().optional(),
  fromFrame: z.number().int().nonnegative(),
  durationInFrames: z.number().int().positive(),
  motion: MotionSchema,
  transitionIn: TransitionSchema,
});
export type TimelineClip = z.infer<typeof TimelineClipSchema>;

export const TimelineOverlaySchema = z.object({
  text: z.string().min(1),
  fromFrame: z.number().int().nonnegative(),
  durationInFrames: z.number().int().positive(),
  position: OverlayPositionSchema,
  animation: OverlayAnimationSchema,
});
export type TimelineOverlay = z.infer<typeof TimelineOverlaySchema>;

export const TimelineSchema = z.object({
  fps: z.literal(30),
  width: z.literal(1080),
  height: z.literal(1920),
  durationInFrames: z.number().int().positive(),
  language: LanguageSchema,
  direction: z.enum(["rtl", "ltr"]),
  style: z.object({
    captionPreset: CaptionPresetSchema,
    font: z.string().min(1),
    palette: z.array(z.string()).min(1),
  }),
  audio: z.object({
    voiceUrl: z.string().optional(),
    musicUrl: z.string().optional(),
    musicDuckingDb: z.number(),
  }),
  clips: z.array(TimelineClipSchema),
  captions: z.object({ words: z.array(WordSchema) }),
  overlays: z.array(TimelineOverlaySchema),
});
export type Timeline = z.infer<typeof TimelineSchema>;
