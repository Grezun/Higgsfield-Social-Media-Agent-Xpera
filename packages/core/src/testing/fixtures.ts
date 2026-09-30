export const validStoryboard = () => ({
  version: 1,
  title: "3 tips",
  language: "he",
  format: "faceless",
  aspect: "9:16",
  targetDurationSec: 30,
  voice: { voiceId: "voice-1", modelId: "eleven_v4" },
  style: { captionPreset: "bold_pop", font: "Heebo", palette: ["#FFE14D", "#111111"], pacing: "punchy" },
  scenes: [
    {
      id: "s1",
      script: "3 טיפים ל-TikTok!",
      visual: { kind: "image", prompt: "phone on a desk, soft light", motion: "zoom_in" },
      overlays: [{ text: "טיפ 1", position: "top", animation: "pop" }],
      transitionOut: "fade",
    },
    {
      id: "s2",
      script: "Second scene script",
      visual: { kind: "graphic" },
      overlays: [],
      transitionOut: "cut",
    },
  ],
});
