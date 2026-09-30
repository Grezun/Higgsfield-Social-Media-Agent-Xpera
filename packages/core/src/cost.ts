import { SpendCapError, UnknownCostModelError } from "./errors";
import type { Language, Storyboard } from "./schema/storyboard";

export type CostTable = Record<string, { perImage?: number; perSecond?: number; per1kChars?: number }>;

/**
 * Estimated USD prices. These are planning numbers, not invoices: check them against your
 * Higgsfield and ElevenLabs plans and edit here (Plan 1b moves this table into settings).
 */
export const DEFAULT_COST_TABLE: CostTable = {
  "higgsfield-ai/soul/v2/standard": { perImage: 0.04 },
  "bytedance/seedance-2.5/image-to-video": { perSecond: 0.08 },
  "elevenlabs/eleven_v4": { per1kChars: 0.3 },
};

export const WORDS_PER_SECOND: Record<Language, number> = { he: 2.3, en: 2.6 };

export function estimateSceneSeconds(script: string, language: Language): number {
  const words = script.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(2, words / WORDS_PER_SECOND[language]);
}

export function videoBillSeconds(sceneSec: number): number {
  return Math.min(30, Math.max(4, Math.ceil(sceneSec)));
}

export type CostLine = { item: string; model: string; quantity: number; unit: string; usd: number };
export type CostEstimate = { totalUsd: number; lines: CostLine[] };

function price(table: CostTable, model: string, key: "perImage" | "perSecond" | "per1kChars"): number {
  const value = table[model]?.[key];
  if (value === undefined) throw new UnknownCostModelError(model);
  return value;
}

export function estimateCost(
  sb: Storyboard,
  models: { image: string; video: string; voice: string },
  table: CostTable = DEFAULT_COST_TABLE,
): CostEstimate {
  const lines: CostLine[] = [];
  for (const scene of sb.scenes) {
    const kind = scene.visual.kind;
    if (kind === "image" || kind === "broll_video") {
      const model = scene.visual.model && kind === "image" ? scene.visual.model : models.image;
      lines.push({ item: `image ${scene.id}`, model, quantity: 1, unit: "image", usd: price(table, model, "perImage") });
    }
    if (kind === "broll_video") {
      const model = scene.visual.model ?? models.video;
      const seconds = videoBillSeconds(estimateSceneSeconds(scene.script, sb.language));
      lines.push({ item: `video ${scene.id}`, model, quantity: seconds, unit: "s", usd: seconds * price(table, model, "perSecond") });
    }
  }
  if (sb.voice) {
    const chars = sb.scenes.map((s) => s.script).join(" ").length;
    lines.push({ item: "voice", model: models.voice, quantity: chars, unit: "chars", usd: (chars / 1000) * price(table, models.voice, "per1kChars") });
  }
  return { totalUsd: lines.reduce((sum, l) => sum + l.usd, 0), lines };
}

export function assertWithinCap(estimate: CostEstimate, capUsd: number): void {
  if (estimate.totalUsd > capUsd) throw new SpendCapError(estimate.totalUsd, capUsd);
}
