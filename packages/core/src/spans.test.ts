import { describe, expect, it } from "vitest";
import { MIN_SPAN_MS, sceneSpans } from "./spans";
import type { Word } from "./schema/timeline";

const words = (n: number, stepMs = 400): Word[] =>
  Array.from({ length: n }, (_, i) => ({ text: `w${i}`, startMs: i * stepMs, endMs: i * stepMs + stepMs - 50 }));

describe("sceneSpans", () => {
  it("maps each scene to the start of its first word when counts match", () => {
    const spans = sceneSpans(["a b", "c d e", "f"], words(6), 2600);
    expect(spans).toEqual([
      { sceneIndex: 0, startMs: 0, endMs: 800 },
      { sceneIndex: 1, startMs: 800, endMs: 2000 },
      { sceneIndex: 2, startMs: 2000, endMs: 2600 },
    ]);
  });

  it("scales boundaries proportionally when word counts do not match (e.g. '5' spoken as 'five hundred')", () => {
    const spans = sceneSpans(["a b", "c d"], words(8), 3400);
    expect(spans[0].startMs).toBe(0);
    expect(spans[1].startMs).toBe(1600); // boundary at word 4 of 8
    expect(spans[1].endMs).toBe(3400);
  });

  it("stays monotonic, covers the whole audio, and enforces MIN_SPAN_MS", () => {
    // 10 scripted words but only 2 timed words → rounding would collapse scenes
    const spans = sceneSpans(["a", "b", "c", "d e f g h i j"], words(2), 4000);
    for (let i = 0; i < spans.length; i++) {
      expect(spans[i].endMs - spans[i].startMs).toBeGreaterThanOrEqual(MIN_SPAN_MS);
      if (i > 0) expect(spans[i].startMs).toBe(spans[i - 1].endMs);
    }
    expect(spans[0].startMs).toBe(0);
    expect(spans.at(-1)!.endMs).toBe(4000);
  });

  it("splits duration by word count when there are no timed words", () => {
    const spans = sceneSpans(["a", "b c d"], [], 4000);
    expect(spans.map((s) => [s.startMs, s.endMs])).toEqual([[0, 1000], [1000, 4000]]);
  });
});
