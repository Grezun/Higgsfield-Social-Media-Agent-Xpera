import { describe, expect, it } from "vitest";
import { alignmentToWords } from "./words";

const align = (text: string, stepSec = 0.1) => {
  const characters = [...text];
  return {
    characters,
    characterStartTimesSeconds: characters.map((_, i) => i * stepSec),
    characterEndTimesSeconds: characters.map((_, i) => (i + 1) * stepSec),
  };
};

describe("alignmentToWords", () => {
  it("groups characters into words split on whitespace", () => {
    expect(alignmentToWords(align("Hi there"))).toEqual([
      { text: "Hi", startMs: 0, endMs: 200 },
      { text: "there", startMs: 300, endMs: 800 },
    ]);
  });

  it("keeps Hebrew punctuation, numbers and embedded English attached to their words", () => {
    const words = alignmentToWords(align("3 טיפים ל-TikTok!"));
    expect(words.map((w) => w.text)).toEqual(["3", "טיפים", "ל-TikTok!"]);
    expect(words[2].startMs).toBe(800);
    expect(words[2].endMs).toBe(1700);
  });

  it("ignores repeated whitespace and newlines", () => {
    expect(alignmentToWords(align("a  \n b")).map((w) => w.text)).toEqual(["a", "b"]);
  });

  it("returns [] for empty alignment", () => {
    expect(alignmentToWords({ characters: [], characterStartTimesSeconds: [], characterEndTimesSeconds: [] })).toEqual([]);
  });
});
