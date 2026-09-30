import type { TimelineClip } from "@reel/core";

export type Motion = TimelineClip["motion"];
export type Transition = TimelineClip["transitionIn"];
export const TRANSITION_FRAMES = 8;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const easeOutCubic = (p: number) => 1 - Math.pow(1 - p, 3);

/** Ken Burns-style camera move across the whole clip. */
export function motionTransform(motion: Motion, frame: number, durationInFrames: number): string {
  const p = clamp01(frame / Math.max(1, durationInFrames - 1));
  switch (motion) {
    case "zoom_in":
      return `scale(${(1 + 0.15 * p).toFixed(4)})`;
    case "zoom_out":
      return `scale(${(1.15 - 0.15 * p).toFixed(4)})`;
    case "pan_left":
      return `scale(1.12) translateX(${(4 - 8 * p).toFixed(3)}%)`;
    case "pan_right":
      return `scale(1.12) translateX(${(-4 + 8 * p).toFixed(3)}%)`;
    default:
      return "none";
  }
}

/** How a clip enters on top of the previous one during its first TRANSITION_FRAMES. */
export function enterStyle(transition: Transition, frame: number): { opacity?: number; transform?: string } {
  if (transition === "cut") return {};
  const e = easeOutCubic(clamp01(frame / TRANSITION_FRAMES));
  switch (transition) {
    case "fade":
      return { opacity: e };
    case "whip":
      return { transform: `translateX(${((1 - e) * 100).toFixed(2)}%)` };
    case "zoom":
      return { opacity: e, transform: `scale(${(1.3 - 0.3 * e).toFixed(4)})` };
  }
}

export function popScale(frame: number, frames = 8): number {
  return 0.6 + 0.4 * easeOutCubic(clamp01(frame / frames));
}

export function typedLength(text: string, frame: number, framesPerChar = 2): number {
  return Math.min([...text].length, Math.floor(frame / framesPerChar) + 1);
}
