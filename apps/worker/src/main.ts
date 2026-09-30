import type { Database } from "@reel/db";
import { costModels, createPlannerFor, createProviders, FileAssetStore, loadConfig, loadEnvFile } from "@reel/engine";
import { assertFfmpegAvailable } from "@reel/media";
import { createClient } from "@supabase/supabase-js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkerEnv } from "./env";
import { buildHandlers } from "./handlers";
import { runWorker } from "./loop";
import { SupabaseJobQueue } from "./queue";
import { SupabaseReelDb } from "./reel-db";
import { MirroredAssetStore, SupabaseAssetIndex, SupabaseBlobStore } from "./storage";

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);

loadEnvFile();
const env = loadWorkerEnv(process.env, process.argv.slice(2));
const config = loadConfig(process.env, { providers: env.providers });
log(await assertFfmpegAvailable());

const sb = createClient<Database>(env.supabaseUrl, env.supabaseSecretKey, { auth: { persistSession: false, autoRefreshToken: false } });
const workDir = await mkdtemp(join(tmpdir(), "reel-worker-"));
const fake = env.providers === "fake";
const blobs = new SupabaseBlobStore(sb);

const handlers = buildHandlers({
  mode: fake ? "fake" : "real",
  planner: createPlannerFor(config, workDir),
  providers: createProviders(config, workDir),
  store: new MirroredAssetStore(new FileAssetStore(fake ? join(config.cacheDir, "fake") : config.cacheDir), blobs, new SupabaseAssetIndex(sb), log),
  blobs,
  db: new SupabaseReelDb(sb),
  voices: config.elevenlabs.voices,
  voiceModelId: config.elevenlabs.modelId,
  spendCapUsd: config.spendCapUsd,
  costModels: costModels(config),
});

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log("stopping after the current job…");
    controller.abort();
  });
}

log(`worker ${env.workerId} polling every ${env.pollMs} ms (${env.providers} providers)`);
await runWorker(new SupabaseJobQueue(sb, env.workerId), handlers, { workerId: env.workerId, pollMs: env.pollMs, signal: controller.signal, log });
log("worker stopped");
