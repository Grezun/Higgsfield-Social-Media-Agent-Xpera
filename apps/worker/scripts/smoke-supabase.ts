import { BUCKETS, type Database } from "@reel/db";
import { loadEnvFile } from "@reel/engine";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkerEnv } from "../src/env";
import { SupabaseJobQueue } from "../src/queue";
import { SupabaseBlobStore } from "../src/storage";

// Free check of the hosted project: queue functions, stale requeue and storage round trip. Cleans up after itself.
loadEnvFile();
const env = loadWorkerEnv(process.env, []);
const sb = createClient<Database>(env.supabaseUrl, env.supabaseSecretKey, { auth: { persistSession: false, autoRefreshToken: false } });
const queue = new SupabaseJobQueue(sb, "smoke");
const pass = (msg: string) => console.log(`PASS ${msg}`);
const fail = (msg: string): never => {
  console.error(`FAIL ${msg}`);
  process.exit(1);
};

const { count: queued } = await sb.from("jobs").select("id", { count: "exact", head: true }).eq("status", "queued");
if (queued) fail(`${queued} real job(s) are queued; stop and retry when the queue is empty so this check doesn't claim them`);

const { data: users, error: usersError } = await sb.auth.admin.listUsers({ perPage: 1 });
if (usersError) fail(`auth admin: ${usersError.message}`);
const owner = users!.users[0] ?? fail("no users yet: invite yourself first (Dashboard → Authentication → Users → Invite user)");

const { data: project, error: projectError } = await sb.from("projects").insert({ owner_id: owner.id, title: "smoke test", language: "en" }).select("id").single();
if (projectError || !project) fail(`insert project: ${projectError?.message}`);
pass("insert project");

try {
  const { data: job, error: jobError } = await sb.from("jobs").insert({ project_id: project!.id, type: "plan", payload: {}, created_by: owner.id }).select("id").single();
  if (jobError || !job) fail(`insert job: ${jobError?.message}`);

  const claimed = await queue.claim("smoke");
  if (claimed?.id !== job!.id || claimed.status !== "running" || claimed.attempts !== 1) fail(`claim_job returned ${JSON.stringify(claimed)}`);
  pass("claim_job claims the queued job");
  if (await queue.claim("smoke")) fail("claim_job returned a second job");
  pass("claim_job returns nothing when the queue is empty");

  if (!(await queue.heartbeat(job!.id))) fail("heartbeat did not update the running job");
  await sb.from("jobs").update({ heartbeat_at: new Date(Date.now() - 3_600_000).toISOString() }).eq("id", job!.id);
  if ((await queue.requeueStale(120)) < 1) fail("requeue_stale_jobs did not requeue the stale job");
  const reclaimed = await queue.claim("smoke");
  if (reclaimed?.id !== job!.id || reclaimed.attempts !== 2) fail(`reclaim returned ${JSON.stringify(reclaimed)}`);
  pass("stale job requeued and reclaimed (attempt 2)");

  if (!(await queue.finish(job!.id, { status: "done", progress: { steps: { voice: "done" }, scenes: {} } }))) fail("finish did not update the job");
  const { data: finished } = await sb.from("jobs").select("status, finished_at, progress").eq("id", job!.id).single();
  if (finished?.status !== "done" || !finished.finished_at) fail(`finish wrote ${JSON.stringify(finished)}`);
  pass("finish marks the job done");

  const dir = await mkdtemp(join(tmpdir(), "smoke-"));
  const name = `smoke-${randomUUID()}.txt`;
  await writeFile(join(dir, "up.txt"), "hello storage");
  const blobs = new SupabaseBlobStore(sb);
  await blobs.upload(BUCKETS.assets, name, join(dir, "up.txt"), "text/plain");
  await blobs.download(BUCKETS.assets, name, join(dir, "down.txt"));
  if ((await readFile(join(dir, "down.txt"), "utf8")) !== "hello storage") fail("storage round trip mismatch");
  await sb.storage.from(BUCKETS.assets).remove([name]);
  pass("storage upload/download round trip");
} finally {
  await sb.from("projects").delete().eq("id", project!.id);
}
console.log("All Supabase checks passed.");
