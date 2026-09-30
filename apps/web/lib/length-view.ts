import { estimateStoryboardSeconds, LENGTH_TOLERANCE, type Storyboard } from "@reel/core";

export function describeLength(sb: Pick<Storyboard, "language" | "scenes" | "targetDurationSec">): { text: string; tooLong: boolean } {
  const seconds = Math.round(estimateStoryboardSeconds(sb));
  const tooLong = seconds > sb.targetDurationSec * LENGTH_TOLERANCE;
  const base = `Estimated length ≈ ${seconds} s (target ${sb.targetDurationSec} s)`;
  return { text: tooLong ? `${base}: too long; trim the voiceover or remove scenes.` : base, tooLong };
}
