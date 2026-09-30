import type { Word } from "./schema/timeline";

export type CharacterAlignment = {
  characters: string[];
  characterStartTimesSeconds: number[];
  characterEndTimesSeconds: number[];
};

/** Groups ElevenLabs per-character timings into whitespace-delimited words (works for Hebrew and English). */
export function alignmentToWords(alignment: CharacterAlignment): Word[] {
  const words: Word[] = [];
  let text = "";
  let start = 0;
  let end = 0;
  const flush = () => {
    if (text) words.push({ text, startMs: Math.round(start * 1000), endMs: Math.round(end * 1000) });
    text = "";
  };
  alignment.characters.forEach((ch, i) => {
    if (/\s/.test(ch)) {
      flush();
      return;
    }
    if (!text) start = alignment.characterStartTimesSeconds[i];
    text += ch;
    end = alignment.characterEndTimesSeconds[i];
  });
  flush();
  return words;
}
