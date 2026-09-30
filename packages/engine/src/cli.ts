import {
  assertWithinCap,
  CaptionPresetSchema,
  estimateCost,
  LanguageSchema,
  parseStoryboard,
  SceneFailuresError,
  type CostEstimate,
  type Storyboard,
} from "@reel/core";
import { assertFfmpegAvailable } from "@reel/media";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { FileAssetStore } from "./asset-store";
import { costModels, loadConfig, loadEnvFile, type EngineConfig } from "./config";
import { generateAssets, renderAndExport } from "./pipeline";
import { createPlannerFor, createProviders } from "./providers";
import type { PlanRequest } from "./providers/types";

const USAGE = `Usage:
  npm run reel -- plan --brief "<text>" --out <dir> [--lang he|en] [--length 15|30|45|60]
                       [--pacing calm|punchy] [--captions bold_pop|clean] [--palette "#FFE14D,#111111"]
                       [--voice <elevenlabs voice id>] [--fake]
  npm run reel -- make <dir> [--yes] [--fake]

plan  asks Claude for a storyboard and writes <dir>/storyboard.json. Edit it freely.
make  validates <dir>/storyboard.json, prints the cost estimate, and with --yes generates
      assets and renders <dir>/renders/v<version>/reel.mp4. --fake uses free local stand-ins.`;

class UsageError extends Error {}

const LENGTHS = [15, 30, 45, 60] as const;

function printStoryboard(sb: Storyboard, estimate: CostEstimate, config: EngineConfig): void {
  console.log(`\n${sb.title}  (${sb.language}, ${sb.targetDurationSec}s target, ${sb.scenes.length} scenes)\n`);
  for (const s of sb.scenes) {
    const visual = s.visual.kind === "graphic" ? "graphic" : `${s.visual.kind}/${s.visual.motion}`;
    console.log(`  ${s.id.padEnd(4)} [${visual}] ${s.script}`);
    if (s.visual.prompt) console.log(`       prompt: ${s.visual.prompt}`);
    for (const o of s.overlays) console.log(`       overlay (${o.position}, ${o.animation}): ${o.text}`);
  }
  console.log("\nEstimated cost:");
  for (const line of estimate.lines) console.log(`  ${line.item.padEnd(12)} ${String(line.quantity).padStart(6)} ${line.unit.padEnd(6)} $${line.usd.toFixed(2)}`);
  console.log(`  total${" ".repeat(21)}$${estimate.totalUsd.toFixed(2)}  (cap $${config.spendCapUsd.toFixed(2)})\n`);
}

async function planCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      brief: { type: "string" },
      out: { type: "string" },
      lang: { type: "string", default: "he" },
      length: { type: "string", default: "30" },
      pacing: { type: "string", default: "punchy" },
      captions: { type: "string", default: "bold_pop" },
      palette: { type: "string", default: "#FFE14D,#111111" },
      voice: { type: "string" },
      fake: { type: "boolean", default: false },
    },
  });
  if (!values.brief || !values.out) throw new UsageError("plan needs --brief and --out");
  const language = LanguageSchema.parse(values.lang);
  const length = Number(values.length);
  if (!LENGTHS.includes(length as (typeof LENGTHS)[number])) throw new UsageError(`--length must be one of ${LENGTHS.join(", ")}`);
  if (values.pacing !== "calm" && values.pacing !== "punchy") throw new UsageError("--pacing must be calm or punchy");

  loadEnvFile();
  const config = loadConfig(process.env, { providers: values.fake ? "fake" : "real" });
  const voiceId = values.voice ?? config.elevenlabs.voices[language] ?? (values.fake ? "fake-voice" : undefined);
  if (!voiceId) throw new UsageError(`Set ELEVENLABS_VOICE_${language.toUpperCase()} in .env.local or pass --voice`);

  const req: PlanRequest = {
    brief: values.brief,
    language,
    targetDurationSec: length as PlanRequest["targetDurationSec"],
    pacing: values.pacing,
    captionPreset: CaptionPresetSchema.parse(values.captions),
    palette: values.palette.split(",").map((c) => c.trim()),
    voice: { voiceId, modelId: config.elevenlabs.modelId },
  };
  const workDir = await mkdtemp(join(tmpdir(), "reel-plan-"));
  console.log("Planning with Claude…");
  const sb = await createPlannerFor(config, workDir).plan(req);
  const outDir = resolve(values.out);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "storyboard.json"), JSON.stringify(sb, null, 2));
  printStoryboard(sb, estimateCost(sb, costModels(config)), config);
  console.log(`Wrote ${join(outDir, "storyboard.json")}. Edit it, then run: npm run reel -- make ${values.out} --yes`);
}

async function readStoryboard(dir: string): Promise<Storyboard> {
  const file = join(dir, "storyboard.json");
  let json: unknown;
  try {
    json = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseStoryboard(json);
}

async function makeCommand(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { yes: { type: "boolean", default: false }, fake: { type: "boolean", default: false } },
  });
  const dir = positionals[0];
  if (!dir) throw new UsageError("make needs the reel directory");
  const sb = await readStoryboard(resolve(dir));

  loadEnvFile();
  const config = loadConfig(process.env, { providers: values.fake ? "fake" : "real" });
  const estimate = estimateCost(sb, costModels(config));
  printStoryboard(sb, estimate, config);
  if (config.providers === "real") {
    assertWithinCap(estimate, config.spendCapUsd);
    if (!values.yes) {
      console.log("Nothing generated. Re-run with --yes to spend credits (cached scenes are free).");
      return;
    }
  }

  await assertFfmpegAvailable();
  const tmpDir = await mkdtemp(join(tmpdir(), "reel-make-"));
  const deps = {
    providers: createProviders(config, tmpDir),
    store: new FileAssetStore(config.cacheDir),
    tmpDir,
    log: (msg: string) => console.log(`  ${msg}`),
  };
  const gen = await generateAssets(sb, deps);
  const outDir = join(resolve(dir), "renders", `v${sb.version}`);
  const out = await renderAndExport(sb, gen, deps, outDir, (p) => process.stdout.write(`\r  rendering ${Math.round(p * 100)}%`));
  process.stdout.write("\n");
  console.log(`\nDone:\n  reel:      ${out.reel}\n  preview:   ${out.preview}\n  thumbnail: ${out.thumbnail}`);
}

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  try {
    if (command === "plan") return await planCommand(rest);
    if (command === "make") return await makeCommand(rest);
    console.log(USAGE);
    process.exitCode = command ? 1 : 0;
  } catch (err) {
    if (err instanceof UsageError) console.error(`${err.message}\n\n${USAGE}`);
    else console.error(err instanceof Error ? err.message : String(err));
    if (err instanceof SceneFailuresError) {
      console.error("Fix those scenes' visual.prompt in storyboard.json and run make again. Finished scenes are cached and will not be charged again.");
    }
    process.exitCode = 1;
  }
}

// pathToFileURL percent-encodes the path, matching import.meta.url even when the repo path contains spaces.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
