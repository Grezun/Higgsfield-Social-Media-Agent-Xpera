import { PermanentProviderError } from "@reel/core";
import { makeTestImage, makeTestTone, makeTestVideo } from "@reel/media";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildStoryboard } from "../planner";
import type { Planner, PlanRequest, Providers } from "./types";

const COLORS = ["0x2E86AB", "0xE4572E", "0x76B041", "0xFFC914", "0x7D5BA6"];
const WORD_MS = 350;

const FAKE_SCRIPTS = {
  he: ["3 טיפים ל-TikTok שכדאי להכיר", "טיפ ראשון: תפתחו עם הוק חזק", "שמרו ועקבו לעוד טיפים"],
  en: ["3 TikTok tips you should know", "Tip one: open with a strong hook", "Save this and follow for more"],
};

/** Deterministic, free providers backed by lavfi fixtures, for tests and `--fake` runs. */
export function createFakeProviders(opts: { workDir: string; failPromptsContaining?: string }) {
  const calls = { image: 0, video: 0, upload: 0, voice: 0, plan: 0 };
  let n = 0;
  const nextFile = (ext: string) => join(opts.workDir, `fake-${++n}.${ext}`);

  const providers: Providers & { planner: Planner; calls: typeof calls } = {
    calls,
    image: {
      model: "higgsfield-ai/soul/v2/standard",
      async generate({ prompt }) {
        calls.image++;
        if (opts.failPromptsContaining && prompt.includes(opts.failPromptsContaining)) {
          throw new PermanentProviderError("Higgsfield (fake) was blocked by content moderation", "fake", "fake-req");
        }
        const out = nextFile("png");
        await makeTestImage(out, { color: COLORS[n % COLORS.length] });
        return { url: pathToFileURL(out).href, requestId: `fake-image-${n}` };
      },
    },
    video: {
      model: "bytedance/seedance-2.5/image-to-video",
      async imageToVideo({ durationSec }) {
        calls.video++;
        const out = nextFile("mp4");
        await makeTestVideo(out, { durationSec, width: 720, height: 1280, fps: 24 });
        return { url: pathToFileURL(out).href, requestId: `fake-video-${n}` };
      },
    },
    uploader: {
      async upload() {
        calls.upload++;
        return `https://fake.local/upload-${calls.upload}`;
      },
    },
    voice: {
      async synthesize({ text }) {
        calls.voice++;
        const tokens = text.trim().split(/\s+/);
        const words = tokens.map((t, i) => ({ text: t, startMs: i * WORD_MS, endMs: i * WORD_MS + WORD_MS - 50 }));
        const out = nextFile("wav");
        await makeTestTone(out, { durationSec: (tokens.length * WORD_MS) / 1000, volumeDb: -20 });
        return { audio: await readFile(out), ext: "wav", words, timingSource: "alignment" };
      },
    },
    planner: {
      async plan(req: PlanRequest) {
        calls.plan++;
        const [hook, tip, cta] = FAKE_SCRIPTS[req.language];
        return buildStoryboard(
          {
            title: req.brief.slice(0, 120),
            scenes: [
              { script: hook, visual: { kind: "image", prompt: "smartphone on a desk, soft morning light", motion: "zoom_in" }, overlays: [], transitionOut: "whip" },
              { script: tip, visual: { kind: "broll_video", prompt: "hands scrolling a phone, close-up", motion: "none" }, overlays: [], transitionOut: "fade" },
              { script: cta, visual: { kind: "graphic", prompt: "", motion: "none" }, overlays: [{ text: req.language === "he" ? "עקבו" : "Follow", position: "center", animation: "pop" }], transitionOut: "cut" },
            ],
          },
          req,
        );
      },
    },
  };
  return providers;
}
