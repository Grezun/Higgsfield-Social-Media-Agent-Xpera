import { estimateSceneSeconds, WORDS_PER_SECOND } from "./cost";
import type { Language, Storyboard } from "./schema/storyboard";

/** How far over the target a storyboard may run before the planner repairs it or the editor warns. */
export const LENGTH_TOLERANCE = 1.25;
const SECONDS_PER_SCENE_MIN = 2.5;

export const maxScenesFor = (targetSec: number) => Math.ceil(targetSec / SECONDS_PER_SCENE_MIN);
export const targetWordsFor = (targetSec: number, language: Language) => Math.round(targetSec * WORDS_PER_SECOND[language]);

export function estimateStoryboardSeconds(sb: Pick<Storyboard, "language" | "scenes">): number {
  return sb.scenes.reduce((sum, s) => sum + estimateSceneSeconds(s.script, sb.language), 0);
}

export function lengthIssues(sb: Pick<Storyboard, "language" | "scenes" | "targetDurationSec">): string[] {
  const issues: string[] = [];
  const seconds = estimateStoryboardSeconds(sb);
  if (seconds > sb.targetDurationSec * LENGTH_TOLERANCE) {
    issues.push(
      `The voiceover is about ${Math.round(seconds)} s of speech but the target is ${sb.targetDurationSec} s: cut it to about ${targetWordsFor(sb.targetDurationSec, sb.language)} words in total.`,
    );
  }
  const maxScenes = maxScenesFor(sb.targetDurationSec);
  if (sb.scenes.length > maxScenes) issues.push(`Use at most ${maxScenes} scenes (you wrote ${sb.scenes.length}).`);
  return issues;
}
