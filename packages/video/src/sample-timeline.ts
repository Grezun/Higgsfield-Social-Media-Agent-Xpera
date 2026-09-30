import type { Timeline, Word } from "@reel/core";

const timedWords = (script: string, stepMs = 380): Word[] =>
  script.split(" ").map((text, i) => ({ text, startMs: i * stepMs, endMs: i * stepMs + stepMs - 40 }));

/** A media-free timeline (graphic clips only) for Remotion Studio and render tests. */
export function sampleTimeline(lang: "he" | "en"): Timeline {
  const script =
    lang === "he"
      ? "3 טיפים ל-TikTok! ככה תגדילו את החשיפה שלכם כבר השבוע"
      : "3 tips for TikTok! Here is how to grow your reach this week";
  const words = timedWords(script);
  const durationInFrames = Math.ceil(((words[words.length - 1].endMs + 400) * 30) / 1000);
  const half = Math.floor(durationInFrames / 2);
  return {
    fps: 30,
    width: 1080,
    height: 1920,
    durationInFrames,
    language: lang,
    direction: lang === "he" ? "rtl" : "ltr",
    style: { captionPreset: "bold_pop", font: "Heebo", palette: ["#FFE14D", "#1B1B3A"] },
    audio: { musicDuckingDb: -18 },
    clips: [
      { sceneId: "s1", kind: "graphic", fromFrame: 0, durationInFrames: half, motion: "zoom_in", transitionIn: "cut" },
      { sceneId: "s2", kind: "graphic", fromFrame: half, durationInFrames: durationInFrames - half, motion: "none", transitionIn: "whip" },
    ],
    captions: { words },
    overlays: [
      { text: lang === "he" ? "טיפ 1" : "Tip 1", fromFrame: 0, durationInFrames: half, position: "top", animation: "pop" },
    ],
  };
}
