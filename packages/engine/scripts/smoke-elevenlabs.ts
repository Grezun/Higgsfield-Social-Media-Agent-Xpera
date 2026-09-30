import { alignmentToWords } from "@reel/core";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, loadEnvFile, REPO_ROOT } from "../src/config";
import { sdkElevenLabs } from "../src/providers/elevenlabs";

// Checks that eleven_v4 returns character alignment for Hebrew and English (spends a few credits).
loadEnvFile();
const config = loadConfig();
if (!config.elevenlabs.apiKey) {
  console.error("ELEVENLABS_API_KEY is not set in .env.local");
  process.exit(1);
}
const api = sdkElevenLabs(config.elevenlabs.apiKey);
const samples = { he: "3 טיפים ל-TikTok! ככה תגדילו את החשיפה.", en: "3 tips for TikTok! Here is how to grow your reach." };
const outDir = join(REPO_ROOT, "work", "smoke");
await mkdir(outDir, { recursive: true });

let ok = true;
for (const lang of ["he", "en"] as const) {
  const voiceId = config.elevenlabs.voices[lang];
  if (!voiceId) {
    console.error(`ELEVENLABS_VOICE_${lang.toUpperCase()} is not set in .env.local`);
    ok = false;
    continue;
  }
  const res = await api.tts(voiceId, { text: samples[lang], modelId: config.elevenlabs.modelId, languageCode: lang, outputFormat: "mp3_44100_128" });
  const file = join(outDir, `voice-${lang}.mp3`);
  await writeFile(file, Buffer.from(res.audioBase64, "base64"));
  const chars = res.alignment?.characters.length ?? 0;
  console.log(`${lang}: ${config.elevenlabs.modelId} → ${file}; alignment chars ${chars} / text chars ${[...samples[lang]].length}`);
  if (!res.alignment || chars === 0) {
    console.error(`${lang}: NO ALIGNMENT. The engine will fall back to Scribe transcription for word timings.`);
    ok = false;
  } else {
    console.log("   " + alignmentToWords(res.alignment).map((w) => `${w.text}@${w.startMs}ms`).join("  "));
  }
}
process.exitCode = ok ? 0 : 1;
