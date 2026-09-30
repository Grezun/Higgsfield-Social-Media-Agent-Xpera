import type { Word } from "./schema/timeline";

export type SceneSpan = { sceneIndex: number; startMs: number; endMs: number };
export const MIN_SPAN_MS = 500;

const countWords = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/**
 * Assigns each scene a [startMs, endMs) span of the voice track.
 * Exact when the timed word count matches the scripts; otherwise boundaries are scaled
 * proportionally. Spans are contiguous, start at 0, end at audioDurationMs, and are at
 * least MIN_SPAN_MS long whenever the audio is long enough to allow it.
 */
export function sceneSpans(sceneScripts: string[], words: Word[], audioDurationMs: number): SceneSpan[] {
  const counts = sceneScripts.map(countWords);
  const expected = counts.reduce((a, b) => a + b, 0) || 1;
  const cumulative: number[] = [];
  counts.reduce((acc, c) => {
    cumulative.push(acc);
    return acc + c;
  }, 0);

  const starts = cumulative.map((wordIndex, i) => {
    if (i === 0) return 0;
    if (words.length === 0) return Math.round((wordIndex / expected) * audioDurationMs);
    const idx = words.length === expected ? wordIndex : Math.round((wordIndex * words.length) / expected);
    return words[Math.min(idx, words.length - 1)].startMs;
  });

  const n = starts.length;
  const canEnforce = audioDurationMs >= n * MIN_SPAN_MS;
  if (canEnforce) {
    for (let i = 1; i < n; i++) starts[i] = Math.max(starts[i], starts[i - 1] + MIN_SPAN_MS);
    for (let i = n - 1; i >= 1; i--) {
      const latest = (i === n - 1 ? audioDurationMs : starts[i + 1]) - MIN_SPAN_MS;
      starts[i] = Math.min(starts[i], latest);
    }
  }

  return starts.map((startMs, i) => ({
    sceneIndex: i,
    startMs,
    endMs: i === n - 1 ? audioDurationMs : starts[i + 1],
  }));
}
