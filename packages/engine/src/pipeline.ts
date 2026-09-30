import {
  assemble,
  DEFAULT_COST_TABLE,
  DEFAULT_TAIL_MS,
  inputHash,
  SceneFailuresError,
  sceneSpans,
  UnsupportedFormatError,
  videoBillSeconds,
  WordSchema,
  type SceneSpan,
  type Storyboard,
  type Timeline,
  type Word,
} from "@reel/core";
import { conformVideo, exportDeliverable, fitDuration, normalizeLoudness, probe, thumbnail, trimTrailingSilence } from "@reel/media";
import { renderReel } from "@reel/video/render";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import type { AssetMeta, FileAssetStore, StoredAsset } from "./asset-store";
import { contentTypeFor, downloadTo, extFromUrl } from "./download";
import type { Providers, VoiceRequest } from "./providers/types";
import { serveDir } from "./serve";

export type PipelineDeps = { providers: Providers; store: FileAssetStore; tmpDir: string; log: (msg: string) => void };
export type GeneratedAssets = {
  voice: StoredAsset;
  words: Word[];
  spans: SceneSpan[];
  visuals: Record<string, { kind: "video" | "image"; asset: StoredAsset }>;
};
export type RenderOutputs = { timeline: Timeline; master: string; reel: string; preview: string; thumbnail: string };

/** Cache keys. Bump a step's `v` when its processing changes so old results are not reused. */
export const hashes = {
  voice: (req: VoiceRequest) => inputHash({ step: "voice", v: 1, ...req }),
  image: (model: string, prompt: string) => inputHash({ step: "image", v: 1, model, prompt }),
  video: (model: string, prompt: string, imageHash: string, durationSec: number) =>
    inputHash({ step: "i2v", v: 1, model, prompt, imageHash, durationSec }),
  fit: (sourceHash: string, targetMs: number) => inputHash({ step: "fit", v: 1, sourceHash, targetMs }),
};

const estUsd = (model: string, key: "perImage" | "perSecond" | "per1kChars", quantity: number) => {
  const price = DEFAULT_COST_TABLE[model]?.[key];
  return price === undefined ? undefined : price * quantity;
};

async function cached(
  store: FileAssetStore,
  hash: string,
  create: () => Promise<{ path: string; ext: string; meta: Omit<AssetMeta, "createdAt"> }>,
): Promise<StoredAsset> {
  const hit = await store.get(hash);
  if (hit) return hit;
  const made = await create();
  return store.putFile(hash, made.path, made.ext, made.meta);
}

export async function generateAssets(sb: Storyboard, deps: PipelineDeps): Promise<GeneratedAssets> {
  if (sb.format !== "faceless") throw new UnsupportedFormatError(sb.format);
  if (!sb.voice) throw new Error("A faceless storyboard needs a voice");
  const { providers: p, store, tmpDir, log } = deps;
  await mkdir(tmpDir, { recursive: true });
  const tmp = (name: string) => join(tmpDir, name);

  // 1. Voice + word timings (everything else is timed from this).
  const voiceReq: VoiceRequest = {
    text: sb.scenes.map((s) => s.script).join(" "),
    voiceId: sb.voice.voiceId,
    modelId: sb.voice.modelId,
    language: sb.language,
    stability: sb.voice.stability,
    style: sb.voice.style,
  };
  const voice = await cached(store, hashes.voice(voiceReq), async () => {
    log("voice: synthesizing");
    const res = await p.voice.synthesize(voiceReq);
    const raw = tmp(`voice-raw.${res.ext}`);
    await writeFile(raw, res.audio);
    const trimmed = tmp("voice-trimmed.wav");
    await trimTrailingSilence(raw, trimmed);
    const normalized = tmp("voice.wav");
    await normalizeLoudness(trimmed, normalized);
    return {
      path: normalized,
      ext: "wav",
      meta: {
        kind: "audio",
        provider: "elevenlabs",
        model: voiceReq.modelId,
        requestId: res.requestId,
        estUsd: estUsd(`elevenlabs/${voiceReq.modelId}`, "per1kChars", voiceReq.text.length / 1000),
        extra: { words: res.words, timingSource: res.timingSource },
      },
    };
  });
  const words = z.array(WordSchema).parse(voice.meta.extra?.words ?? []);
  const durationMs = Math.round((await probe(voice.path)).durationSec * 1000);
  const spans = sceneSpans(sb.scenes.map((s) => s.script), words, durationMs);

  // 2. Visuals, all scenes in parallel (the Higgsfield gateway enforces the account concurrency limit).
  const visuals: GeneratedAssets["visuals"] = {};
  const failures: { sceneId: string; reason: string }[] = [];
  const last = sb.scenes.length - 1;
  await Promise.all(
    sb.scenes.map(async (scene, i) => {
      const { kind, prompt } = scene.visual;
      if (kind === "graphic") return;
      try {
        if (!prompt) throw new Error("missing visual prompt");
        const sceneSec = (spans[i].endMs - spans[i].startMs + (i === last ? DEFAULT_TAIL_MS : 0)) / 1000;
        const image = await cached(store, hashes.image(p.image.model, prompt), async () => {
          log(`${scene.id}: generating image`);
          const res = await p.image.generate({ prompt });
          const ext = extFromUrl(res.url, "png");
          const file = tmp(`${scene.id}-image.${ext}`);
          await downloadTo(res.url, file);
          return { path: file, ext, meta: { kind: "image", provider: "higgsfield", model: p.image.model, requestId: res.requestId, estUsd: estUsd(p.image.model, "perImage", 1) } };
        });
        if (kind === "image") {
          visuals[scene.id] = { kind: "image", asset: image };
          return;
        }
        const billSec = videoBillSeconds(sceneSec);
        const rawVideo = await cached(store, hashes.video(p.video.model, prompt, image.hash, billSec), async () => {
          log(`${scene.id}: animating image (${billSec}s)`);
          const imageUrl = await p.uploader.upload(await readFile(image.path), contentTypeFor(image.fileName));
          const res = await p.video.imageToVideo({ imageUrl, prompt, durationSec: billSec });
          const file = tmp(`${scene.id}-raw.mp4`);
          await downloadTo(res.url, file);
          return { path: file, ext: "mp4", meta: { kind: "video", provider: "higgsfield", model: p.video.model, requestId: res.requestId, estUsd: estUsd(p.video.model, "perSecond", billSec) } };
        });
        const targetMs = Math.round(sceneSec * 1000);
        const fitted = await cached(store, hashes.fit(rawVideo.hash, targetMs), async () => {
          const conformed = tmp(`${scene.id}-conformed.mp4`);
          await conformVideo(rawVideo.path, conformed);
          const out = tmp(`${scene.id}-fitted.mp4`);
          await fitDuration(conformed, out, targetMs / 1000);
          return { path: out, ext: "mp4", meta: { kind: "video", provider: "ffmpeg" } };
        });
        visuals[scene.id] = { kind: "video", asset: fitted };
      } catch (err) {
        failures.push({ sceneId: scene.id, reason: err instanceof Error ? err.message : String(err) });
      }
    }),
  );
  if (failures.length) throw new SceneFailuresError(failures.sort((a, b) => a.sceneId.localeCompare(b.sceneId)));
  return { voice, words, spans, visuals };
}

export async function renderAndExport(
  sb: Storyboard,
  gen: GeneratedAssets,
  deps: PipelineDeps,
  outDir: string,
  onProgress?: (progress: number) => void,
): Promise<RenderOutputs> {
  await mkdir(outDir, { recursive: true });
  const server = await serveDir(deps.store.root);
  try {
    const timeline = assemble({
      storyboard: sb,
      spans: gen.spans,
      words: gen.words,
      visuals: Object.fromEntries(
        Object.entries(gen.visuals).map(([id, v]) => [id, { kind: v.kind, src: server.urlFor(v.asset.fileName) }]),
      ),
      voiceUrl: server.urlFor(gen.voice.fileName),
    });
    // Asset URLs in timeline.json point at the temporary local server and are only valid during this render.
    await writeFile(join(outDir, "timeline.json"), JSON.stringify(timeline, null, 2));
    const master = join(outDir, "master.mp4");
    deps.log("render: Remotion");
    await renderReel(timeline, master, onProgress);
    const reel = join(outDir, "reel.mp4");
    deps.log("export: social_1080p");
    await exportDeliverable(master, reel, "social_1080p");
    const preview = join(outDir, "preview.mp4");
    await exportDeliverable(master, preview, "preview_540p");
    const thumb = join(outDir, "thumbnail.jpg");
    await thumbnail(master, thumb, Math.min(1, timeline.durationInFrames / 30 / 2));
    return { timeline, master, reel, preview, thumbnail: thumb };
  } finally {
    await server.close();
  }
}
